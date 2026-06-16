// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ulid } from "ulid";
import type { WebSocket } from "ws";
import type { ActiveLogStream, ClusterConnection, ConnectionRole, LokiStreamMeta, PendingRequest } from "@/types/websocket-message.js";
import { createWSError } from "@/types/websocket-message.js";
import type { ConnectionManagerConfig, Session } from "@/types/index.js";
import type { NodeTask } from "@/lib/tasks/types.js";
import type { NodeStateEntity } from "@/lib/constants/node-state.js";
import { DEFAULT_CONFIG, MESSAGE_KIND, WSErrorCode } from "@/lib/constants/websocket.js";
import { Logger } from "@/lib/logger.js";

/**
 * Manages WebSocket connections, pending requests, and log stream subscriptions.
 */
export class ConnectionManager {
  private connections = new Map<string, Set<ClusterConnection>>();
  private connectionById = new Map<string, ClusterConnection>();
  private nodesByClusterId = new Map<string, Set<ClusterConnection>>();
  private connectionByWs = new Map<WebSocket, ClusterConnection>();
  private logStreams = new Map<string, ActiveLogStream>();
  private nodeStreamIndex = new Map<string, string>();
  private pendingRequests = new Map<string, PendingRequest>();
  private requestsByClient = new Map<WebSocket, Set<string>>();
  private unackedMessages = new Map<string, { message: unknown; timestamp: number; retries: number }>();
  private fileWatchSubscriptions = new Map<string, Set<string>>();
  private connWatches = new Map<string, Set<string>>();
  private config: ConnectionManagerConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastActivityMap = new Map<WebSocket, number>();
  private clientVersions = new Map<string, Map<string, number>>();
  private log = new Logger("ws-connections");

  constructor(config: Partial<ConnectionManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupLoop();
  }

  /**
   * Start periodic cleanup of dead connections and timed-out requests
   */
  private startCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupTimedOutRequests();
      this.cleanupDeadConnections();
      this.cleanupOrphanedLogStreams();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Stop the cleanup loop
   */
  stopCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Add a new websocket connection
   * @param connectionKey - The key to register the connection under (instance tag for nodes, clusterId for clients)
   * @param ws - The WebSocket connection
   * @param role - Whether this is a node or client connection
   * @param session - Optional session info for clients
   * @param clusterId - Optional actual cluster ID (for nodes that need to notify clients)
   */
  addConnection(connectionKey: string, ws: WebSocket, role: ConnectionRole, session?: Session, clusterId?: string): ClusterConnection {
    if (!this.connections.has(connectionKey)) {
      this.connections.set(connectionKey, new Set());
    }

    const connectionId = ulid();
    const conn: ClusterConnection = {
      ws,
      role,
      connectionKey,
      clusterId,
      session,
      connectionId,
      connectedAt: Date.now(),
    };

    this.connections.get(connectionKey)!.add(conn);
    this.connectionById.set(connectionId, conn);
    this.connectionByWs.set(ws, conn);
    if (role === "node" && clusterId) {
      if (!this.nodesByClusterId.has(clusterId)) {
        this.nodesByClusterId.set(clusterId, new Set());
      }
      this.nodesByClusterId.get(clusterId)!.add(conn);
    }
    this.lastActivityMap.set(ws, Date.now());
    this.requestsByClient.set(ws, new Set());

    this.log.info(`${role} connected to ${connectionKey} (connId: ${connectionId})`);
    return conn;
  }

  /**
   * Remove a websocket connection
   */
  removeConnection(conn: ClusterConnection): void {
    const conns = this.connections.get(conn.connectionKey);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) {
        this.connections.delete(conn.connectionKey);
      }
    }
    this.connectionById.delete(conn.connectionId);
    this.connectionByWs.delete(conn.ws);
    if (conn.role === "node" && conn.clusterId) {
      const nodeSet = this.nodesByClusterId.get(conn.clusterId);
      if (nodeSet) {
        nodeSet.delete(conn);
        if (nodeSet.size === 0) this.nodesByClusterId.delete(conn.clusterId);
      }
    }

    this.cleanupRequestsForClient(conn.ws);

    if (conn.role === "client") {
      this.removeLogStreamsForClient(conn.ws);
      this.removeFileWatchesForConnection(conn.connectionId);
    }

    this.lastActivityMap.delete(conn.ws);
    this.requestsByClient.delete(conn.ws);
    this.clientVersions.delete(conn.connectionId);

    this.log.info(`${conn.role} disconnected from ${conn.connectionKey}`);
  }

  /**
   * Update last activity timestamp for a connection
   */
  updateActivity(ws: WebSocket): void {
    this.lastActivityMap.set(ws, Date.now());
  }

  /**
   * Get all connections for a cluster
   */
  getConnections(clusterId: string): Set<ClusterConnection> | undefined {
    return this.connections.get(clusterId);
  }

  /**
   * Get all node connections for a cluster
   */
  getNodeConnections(key: string): ClusterConnection[] {
    const conns = this.connections.get(key);
    const found = conns ? Array.from(conns).filter((c) => c.role === "node") : [];
    return found;
  }

  /**
   * Get all client connections for a cluster
   */
  getClientConnections(clusterId: string): ClusterConnection[] {
    const conns = this.connections.get(clusterId);
    if (!conns) return [];
    return Array.from(conns).filter((c) => c.role === "client");
  }

  /**
   * Check if any node is connected for a cluster
   */
  hasNodeConnection(tag: string): boolean {
    return this.getNodeConnections(tag).length > 0;
  }

  /**
   * Find all node connections whose conn.clusterId matches the given cluster ID.
   * Used as a fallback when the DB-based instance lookup fails (e.g. instance.cluster_id is null).
   */
  getNodeConnectionsByClusterId(clusterId: string): ClusterConnection[] {
    return Array.from(this.nodesByClusterId.get(clusterId) ?? []);
  }

  /**
   * Find a connection by its connectionId across all clusters.
   */
  getConnectionById(connectionId: string): ClusterConnection | undefined {
    return this.connectionById.get(connectionId);
  }

  /**
   * Send a task to all nodes reachable via routingKey.
   * Pass clusterId for dedicated instances or `pool:${instance.tag}` for pool instances.
   * Returns true if sent to at least one node.
   */
  sendTask(routingKey: string, task: NodeTask): boolean {
    const nodeConns = this.getNodeConnections(routingKey);
    if (nodeConns.length === 0) {
      this.log.warn(`No node connections for routing key ${routingKey}`);
      return false;
    }

    const payload = JSON.stringify({ kind: MESSAGE_KIND.TASK, items: [task] });
    let sentCount = 0;

    for (const nodeConn of nodeConns) {
      try {
        nodeConn.ws.send(payload);
        sentCount++;
      } catch (err) {
        this.log.error("Failed to send task to node", { error: String(err) });
      }
    }

    this.log.info(`Sent task ${task.ID} to ${sentCount}/${nodeConns.length} nodes (key: ${routingKey})`);
    return sentCount > 0;
  }

  /**
   * Send a heartbeat to all nodes reachable via routingKey.
   * The node responds with an immediate full sync (including workloads).
   */
  sendHeartbeat(routingKey: string): boolean {
    const nodeConns = this.getNodeConnections(routingKey);
    if (nodeConns.length === 0) return false;
    const payload = JSON.stringify({ kind: MESSAGE_KIND.HEARTBEAT });
    let sent = 0;
    for (const nodeConn of nodeConns) {
      try {
        nodeConn.ws.send(payload);
        sent++;
      } catch (err) {
        this.log.error("Failed to send heartbeat to node", { error: String(err) });
      }
    }
    return sent > 0;
  }

  /**
   * Check if client can make more requests (rate limiting)
   */
  canAcceptRequest(ws: WebSocket): boolean {
    const clientRequests = this.requestsByClient.get(ws);
    if (!clientRequests) return true;
    return clientRequests.size < this.config.maxPendingPerClient;
  }

  /**
   * Get pending request count for a client
   */
  getPendingCountForClient(ws: WebSocket): number {
    return this.requestsByClient.get(ws)?.size ?? 0;
  }

  /**
   * Add a pending request
   */
  addPendingRequest(taskId: string, requestId: string, ws: WebSocket, clusterId: string, kind: string, timeoutMs?: number): boolean {
    if (!this.canAcceptRequest(ws)) {
      return false;
    }

    const request: PendingRequest = {
      requestId,
      taskId,
      ws,
      clusterId,
      kind,
      createdAt: Date.now(),
      timeoutMs: timeoutMs ?? this.config.requestTimeoutMs,
    };

    this.pendingRequests.set(taskId, request);

    let clientRequests = this.requestsByClient.get(ws);
    if (!clientRequests) {
      clientRequests = new Set();
      this.requestsByClient.set(ws, clientRequests);
    }
    clientRequests.add(taskId);

    this.log.info(`Pending request added: ${taskId} (requestId: ${requestId})`);
    return true;
  }

  /**
   * Get pending request by taskId
   */
  getPendingRequest(taskId: string): PendingRequest | undefined {
    return this.pendingRequests.get(taskId);
  }

  /**
   * Remove pending request and return it
   */
  removePendingRequest(taskId: string): PendingRequest | undefined {
    const request = this.pendingRequests.get(taskId);
    if (request) {
      this.pendingRequests.delete(taskId);
      this.requestsByClient.get(request.ws)?.delete(taskId);
      this.log.info(`Pending request removed: ${taskId}`);
    }
    return request;
  }

  /**
   * Route response directly to the requesting client
   */
  routeResponseToClient(taskId: string, message: unknown): boolean {
    const request = this.removePendingRequest(taskId);
    if (!request) {
      this.log.debug(`No pending request found for taskId: ${taskId} (internally dispatched task)`);
      return false;
    }

    try {
      const response = {
        ...(message as object),
        requestId: request.requestId,
        taskId,
      };
      request.ws.send(JSON.stringify(response));
      this.log.info(`Routed response for taskId: ${taskId} to requestId: ${request.requestId}`);
      return true;
    } catch (err) {
      this.log.error(`Failed to route response for taskId: ${taskId}`, { error: String(err) });
      return false;
    }
  }

  /**
   * Send error response to client for a pending request
   */
  sendErrorToClient(taskId: string, code: WSErrorCode, message: string): boolean {
    const request = this.removePendingRequest(taskId);
    if (!request) {
      return false;
    }

    try {
      const error = createWSError(request.requestId, code, message);
      request.ws.send(JSON.stringify(error));
      return true;
    } catch (err) {
      this.log.error(`Failed to send error for taskId: ${taskId}`, { error: String(err) });
      return false;
    }
  }

  /**
   * Cleanup timed-out requests
   */
  private cleanupTimedOutRequests(): void {
    const now = Date.now();
    const timedOut: string[] = [];

    for (const [taskId, request] of this.pendingRequests) {
      if (now - request.createdAt > request.timeoutMs) {
        timedOut.push(taskId);
      }
    }

    for (const taskId of timedOut) {
      this.log.info(`Request timed out: ${taskId}`);
      this.sendErrorToClient(taskId, WSErrorCode.NODE_TIMEOUT, "Request timed out");
    }

    if (timedOut.length > 0) {
      this.log.info(`Cleaned up ${timedOut.length} timed-out requests`);
    }
  }

  /**
   * Cleanup all pending requests for a specific client
   */
  private cleanupRequestsForClient(ws: WebSocket): void {
    const clientRequests = this.requestsByClient.get(ws);
    if (!clientRequests) return;

    for (const taskId of clientRequests) {
      const request = this.pendingRequests.get(taskId);
      if (request) {
        this.pendingRequests.delete(taskId);
        this.log.info(`Cleaned up orphaned request: ${taskId}`);
      }
    }

    this.requestsByClient.delete(ws);
  }

  /**
   * Cleanup dead connections based on inactivity
   */
  private cleanupDeadConnections(): void {
    const now = Date.now();
    const dead: ClusterConnection[] = [];

    for (const [ws, lastActivity] of this.lastActivityMap) {
      if (now - lastActivity > this.config.connectionTtlMs && ws.readyState !== 1) {
        const conn = this.connectionByWs.get(ws);
        if (conn) dead.push(conn);
      }
    }

    for (const conn of dead) {
      this.log.info(`Removing dead connection: ${conn.connectionId}`);
      this.removeConnection(conn);
      try {
        conn.ws.terminate();
      } catch {}
    }

    if (dead.length > 0) {
      this.log.info(`Cleaned up ${dead.length} dead connections`);
    }
  }

  /**
   * Register a new background log stream (base-initiated).
   * If a stream for this path already exists, returns false — caller should not send a new node task.
   */
  addLogStream(stream: ActiveLogStream): boolean {
    if (this.logStreams.has(stream.key)) return false;
    this.logStreams.set(stream.key, stream);
    this.nodeStreamIndex.set(stream.nodeStreamId, stream.key);
    this.log.info(`Created log stream ${stream.nodeStreamId} for key "${stream.key}" path="${stream.path}"`);
    return true;
  }

  /**
   * Lookup a stream by the nodeStreamId carried in log_chunk messages.
   */
  getLogStreamByNodeId(nodeStreamId: string): ActiveLogStream | undefined {
    const path = this.nodeStreamIndex.get(nodeStreamId);
    return path ? this.logStreams.get(path) : undefined;
  }

  /**
   * Lookup a stream by its logical path.
   */
  getLogStreamByPath(path: string): ActiveLogStream | undefined {
    return this.logStreams.get(path);
  }

  /**
   * Add a client WebSocket to an existing stream's fanout set.
   * Returns false if no stream exists for this path.
   */
  addClientToLogStream(path: string, clientWs: WebSocket): boolean {
    const stream = this.logStreams.get(path);
    if (!stream) return false;
    stream.clients.add(clientWs);
    return true;
  }

  /**
   * Find active build or deploy streams for a service by name.
   * Used to fan clients into in-flight build/deploy streams without knowing the taskId.
   */
  findBuildDeployStreamsForService(serviceId: string): ActiveLogStream[] {
    const results: ActiveLogStream[] = [];
    for (const stream of this.logStreams.values()) {
      if (stream.meta?.serviceId === serviceId && (stream.key.startsWith("build:") || stream.key.startsWith("deploy:"))) {
        results.push(stream);
      }
    }
    return results;
  }

  /**
   * Remove a client from a stream's fanout set.
   * The background stream itself stays alive.
   */
  removeClientFromLogStream(path: string, clientWs: WebSocket): void {
    this.logStreams.get(path)?.clients.delete(clientWs);
  }

  /**
   * Remove a client WebSocket from all streams (called on client disconnect).
   */
  removeLogStreamsForClient(clientWs: WebSocket): void {
    for (const stream of this.logStreams.values()) {
      stream.clients.delete(clientWs);
    }
  }

  /**
   * Remove log streams matching a path for a specific client (unsubscribe).
   */
  removeLogStreamsByPath(path: string, clientWs: WebSocket): void {
    this.removeClientFromLogStream(path, clientWs);
  }

  /**
   * Fully tear down a background stream (e.g. service deleted or node disconnected).
   */
  removeLogStream(path: string): void {
    const stream = this.logStreams.get(path);
    if (!stream) return;
    this.nodeStreamIndex.delete(stream.nodeStreamId);
    this.logStreams.delete(path);
    this.log.info(`Removed log stream for path "${path}"`);
  }

  /**
   * Purge dead clients from all stream fanout sets each cleanup cycle.
   * Background streams (no clients) are intentionally kept alive.
   */
  private cleanupOrphanedLogStreams(): void {
    let cleaned = 0;
    for (const stream of this.logStreams.values()) {
      for (const ws of stream.clients) {
        if (ws.readyState !== 1) {
          stream.clients.delete(ws);
          cleaned++;
        }
      }
    }
    if (cleaned > 0) {
      this.log.info(`Cleaned up ${cleaned} dead client(s) from log stream fanout sets`);
    }
  }

  /**
   * Add a file watch subscription
   */
  addFileWatch(watchKey: string, connectionId: string): void {
    if (!this.fileWatchSubscriptions.has(watchKey)) {
      this.fileWatchSubscriptions.set(watchKey, new Set());
    }
    this.fileWatchSubscriptions.get(watchKey)!.add(connectionId);
    if (!this.connWatches.has(connectionId)) {
      this.connWatches.set(connectionId, new Set());
    }
    this.connWatches.get(connectionId)!.add(watchKey);
    this.log.info(`Added file watch: ${watchKey} for connection ${connectionId}`);
  }

  /**
   * Remove a file watch subscription
   */
  removeFileWatch(watchKey: string, connectionId: string): boolean {
    const subscribers = this.fileWatchSubscriptions.get(watchKey);
    if (!subscribers) return false;

    const removed = subscribers.delete(connectionId);
    if (subscribers.size === 0) {
      this.fileWatchSubscriptions.delete(watchKey);
    }

    const watched = this.connWatches.get(connectionId);
    if (watched) {
      watched.delete(watchKey);
      if (watched.size === 0) this.connWatches.delete(connectionId);
    }

    if (removed) {
      this.log.info(`Removed file watch: ${watchKey} for connection ${connectionId}`);
    }
    return removed;
  }

  /**
   * Get all subscribers for a file watch
   */
  getFileWatchSubscribers(watchKey: string): Set<string> | undefined {
    return this.fileWatchSubscriptions.get(watchKey);
  }

  /**
   * Remove all file watches for a connection
   */
  removeFileWatchesForConnection(connectionId: string): void {
    const watched = this.connWatches.get(connectionId);
    if (!watched) return;
    for (const watchKey of watched) {
      const subscribers = this.fileWatchSubscriptions.get(watchKey);
      if (subscribers) {
        subscribers.delete(connectionId);
        if (subscribers.size === 0) this.fileWatchSubscriptions.delete(watchKey);
      }
    }
    this.connWatches.delete(connectionId);
  }

  /**
   * Check if a watch key has any subscribers
   */
  hasFileWatchSubscribers(watchKey: string): boolean {
    const subscribers = this.fileWatchSubscriptions.get(watchKey);
    return subscribers ? subscribers.size > 0 : false;
  }

  /**
   * Store message for potential retry on reconnect
   */
  storeUnackedMessage(messageId: string, message: unknown): void {
    this.unackedMessages.set(messageId, {
      message,
      timestamp: Date.now(),
      retries: 0,
    });
  }

  /**
   * Acknowledge a message
   */
  acknowledgeMessage(messageId: string): boolean {
    return this.unackedMessages.delete(messageId);
  }

  /**
   * Get unacked messages for replay (up to maxRetries)
   */
  getUnackedMessages(maxRetries: number = 3): Array<{ messageId: string; message: unknown }> {
    const messages: Array<{ messageId: string; message: unknown }> = [];
    const expired: string[] = [];

    for (const [messageId, data] of this.unackedMessages) {
      if (data.retries >= maxRetries) {
        expired.push(messageId);
      } else {
        messages.push({ messageId, message: data.message });
        data.retries++;
      }
    }

    for (const id of expired) {
      this.unackedMessages.delete(id);
    }

    return messages;
  }

  /**
   * Get connection manager stats for monitoring
   */
  getStats(): {
    totalConnections: number;
    nodeConnections: number;
    clientConnections: number;
    connectionsByCluster: Record<string, number>;
    pendingRequests: number;
    logStreams: number;
    fileWatches: number;
    unackedMessages: number;
  } {
    const connectionsByCluster: Record<string, number> = {};
    let totalConnections = 0;
    let nodeConnections = 0;
    let clientConnections = 0;

    for (const [clusterId, conns] of this.connections) {
      connectionsByCluster[clusterId] = conns.size;
      totalConnections += conns.size;
      nodeConnections += Array.from(conns).filter((c) => c.role === "node").length;
    }
    clientConnections = totalConnections - nodeConnections;

    return {
      totalConnections,
      nodeConnections,
      clientConnections,
      connectionsByCluster,
      pendingRequests: this.pendingRequests.size,
      logStreams: this.logStreams.size,
      fileWatches: this.fileWatchSubscriptions.size,
      unackedMessages: this.unackedMessages.size,
    };
  }

  /**
   * Get the last known version of a section for a specific client.
   * Returns 0 if client hasn't seen this section yet.
   */
  getClientVersion(connectionId: string, instanceId: string, section: NodeStateEntity): number {
    return this.clientVersions.get(connectionId)?.get(`${instanceId}:${section}`) ?? 0;
  }

  /**
   * Update the version a client has for a specific section.
   */
  setClientVersion(connectionId: string, instanceId: string, section: NodeStateEntity, version: number): void {
    if (!this.clientVersions.has(connectionId)) {
      this.clientVersions.set(connectionId, new Map());
    }
    this.clientVersions.get(connectionId)!.set(`${instanceId}:${section}`, version);
  }
}
