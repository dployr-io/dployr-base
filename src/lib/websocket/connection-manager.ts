// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { ClusterConnection, ConnectionRole, LogStreamSubscription, PendingRequest, WSErrorResponse } from "./message-types.js";
import { WSErrorCode, createWSError } from "./message-types.js";
import type { Session } from "@/types/index.js";
import { ulid } from "ulid";

/**
 * Configuration for connection manager
 */
export interface ConnectionManagerConfig {
  requestTimeoutMs: number;
  cleanupIntervalMs: number;
  maxPendingPerClient: number;
  connectionTtlMs: number;
}

const DEFAULT_CONFIG: ConnectionManagerConfig = {
  requestTimeoutMs: 30000,
  cleanupIntervalMs: 10000,
  maxPendingPerClient: 50,
  connectionTtlMs: 300000,
};

/**
 * Manages WebSocket connections, pending requests, and log stream subscriptions.
 */
export class ConnectionManager {
  private connections = new Map<string, Set<ClusterConnection>>();
  private logStreams = new Map<string, LogStreamSubscription>();
  private pendingRequests = new Map<string, PendingRequest>();
  private requestsByClient = new Map<WebSocket, Set<string>>();
  private unackedMessages = new Map<string, { message: unknown; timestamp: number; retries: number }>();
  private config: ConnectionManagerConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastActivityMap = new Map<WebSocket, number>();

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
   * Add a new websocket connection for a cluster
   */
  addConnection(clusterId: string, ws: WebSocket, role: ConnectionRole, session?: Session): ClusterConnection {
    if (!this.connections.has(clusterId)) {
      this.connections.set(clusterId, new Set());
    }

    const connectionId = ulid();
    const conn: ClusterConnection = { 
      ws, 
      role, 
      clusterId, 
      session,
      connectionId,
      connectedAt: Date.now(),
    };
    
    this.connections.get(clusterId)!.add(conn);
    this.lastActivityMap.set(ws, Date.now());
    this.requestsByClient.set(ws, new Set());

    console.log(`[WS] ${role} connected to cluster ${clusterId} (connId: ${connectionId})`);
    return conn;
  }

  /**
   * Remove a websocket connection
   */
  removeConnection(conn: ClusterConnection): void {
    const conns = this.connections.get(conn.clusterId);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) {
        this.connections.delete(conn.clusterId);
      }
    }
    
    this.cleanupRequestsForClient(conn.ws);
    
    if (conn.role === "client") {
      this.removeLogStreamsForClient(conn.ws);
    }
    
    this.lastActivityMap.delete(conn.ws);
    this.requestsByClient.delete(conn.ws);

    console.log(`[WS] ${conn.role} disconnected from cluster ${conn.clusterId}`);
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
   * Get all agent connections for a cluster
   */
  getAgentConnections(instanceId: string): ClusterConnection[] {
    const conns = this.connections.get(instanceId);
    if (!conns) return [];
    return Array.from(conns).filter((c) => c.role === "agent");
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
   * Check if any agent is connected for a cluster
   */
  hasAgentConnection(instanceId: string): boolean {
    return this.getAgentConnections(instanceId).length > 0;
  }

  // ==================== Pending Request Management ====================

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
  addPendingRequest(
    taskId: string,
    requestId: string,
    ws: WebSocket,
    clusterId: string,
    kind: string,
    timeoutMs?: number
  ): boolean {
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

    console.log(`[WS] Pending request added: ${taskId} (requestId: ${requestId})`);
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
      console.log(`[WS] Pending request removed: ${taskId}`);
    }
    return request;
  }

  /**
   * Route response directly to the requesting client
   */
  routeResponseToClient(taskId: string, message: unknown): boolean {
    const request = this.removePendingRequest(taskId);
    if (!request) {
      console.warn(`[WS] No pending request found for taskId: ${taskId}`);
      return false;
    }

    try {
      const response = {
        ...message as object,
        requestId: request.requestId,
        taskId,
      };
      request.ws.send(JSON.stringify(response));
      console.log(`[WS] Routed response for taskId: ${taskId} to requestId: ${request.requestId}`);
      return true;
    } catch (err) {
      console.error(`[WS] Failed to route response for taskId: ${taskId}`, err);
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
      console.error(`[WS] Failed to send error for taskId: ${taskId}`, err);
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
      console.log(`[WS] Request timed out: ${taskId}`);
      this.sendErrorToClient(taskId, WSErrorCode.AGENT_TIMEOUT, "Request timed out");
    }

    if (timedOut.length > 0) {
      console.log(`[WS] Cleaned up ${timedOut.length} timed-out requests`);
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
        console.log(`[WS] Cleaned up orphaned request: ${taskId}`);
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

    for (const [clusterId, conns] of this.connections) {
      for (const conn of conns) {
        const lastActivity = this.lastActivityMap.get(conn.ws) ?? conn.connectedAt;
        if (now - lastActivity > this.config.connectionTtlMs) {
          if (conn.ws.readyState !== 1) {
            dead.push(conn);
          }
        }
      }
    }

    for (const conn of dead) {
      console.log(`[WS] Removing dead connection: ${conn.connectionId}`);
      this.removeConnection(conn);
      try {
        conn.ws.terminate();
      } catch {}
    }

    if (dead.length > 0) {
      console.log(`[WS] Cleaned up ${dead.length} dead connections`);
    }
  }

  // ==================== Log Stream Management ====================

  /**
   * Add a log stream subscription
   */
  addLogStream(subscription: LogStreamSubscription): void {
    this.logStreams.set(subscription.streamId, subscription);
    console.log(`[WS] Created log stream ${subscription.streamId}`);
  }

  /**
   * Get a log stream subscription by ID
   */
  getLogStream(streamId: string): LogStreamSubscription | undefined {
    return this.logStreams.get(streamId);
  }

  /**
   * Update an existing log stream's client WebSocket
   */
  updateLogStreamClient(streamId: string, clientWs: WebSocket): boolean {
    const existing = this.logStreams.get(streamId);
    if (existing) {
      existing.ws = clientWs;
      console.log(`[WS] Reusing existing log stream ${streamId}`);
      return true;
    }
    return false;
  }

  /**
   * Remove a log stream subscription
   */
  removeLogStream(streamId: string): void {
    this.logStreams.delete(streamId);
    console.log(`[WS] Removed log stream ${streamId}`);
  }

  /**
   * Remove all log streams for a specific client WebSocket
   */
  removeLogStreamsForClient(clientWs: WebSocket): void {
    for (const [streamId, subscription] of this.logStreams.entries()) {
      if (subscription.ws === clientWs) {
        this.logStreams.delete(streamId);
        console.log(`[WS] Cleaned up log stream ${streamId}`);
      }
    }
  }

  /**
   * Cleanup orphaned log streams (where client is disconnected)
   */
  private cleanupOrphanedLogStreams(): void {
    const orphaned: string[] = [];

    for (const [streamId, subscription] of this.logStreams) {
      if (subscription.ws.readyState !== 1) {
        orphaned.push(streamId);
      }
    }

    for (const streamId of orphaned) {
      this.logStreams.delete(streamId);
    }

    if (orphaned.length > 0) {
      console.log(`[WS] Cleaned up ${orphaned.length} orphaned log streams`);
    }
  }

  /**
   * Remove log streams matching a path for a specific client
   */
  removeLogStreamsByPath(path: string, clientWs: WebSocket): void {
    for (const [streamId, subscription] of this.logStreams.entries()) {
      if (subscription.path === path && subscription.ws === clientWs) {
        this.logStreams.delete(streamId);
        console.log(`[WS] Removed log stream ${streamId}`);
      }
    }
  }

  // ==================== Acknowledgment System ====================

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

  // ==================== Metrics ====================

  /**
   * Get connection manager stats for monitoring
   */
  getStats(): {
    totalConnections: number;
    connectionsByCluster: Record<string, number>;
    pendingRequests: number;
    logStreams: number;
    unackedMessages: number;
  } {
    const connectionsByCluster: Record<string, number> = {};
    let totalConnections = 0;

    for (const [clusterId, conns] of this.connections) {
      connectionsByCluster[clusterId] = conns.size;
      totalConnections += conns.size;
    }

    return {
      totalConnections,
      connectionsByCluster,
      pendingRequests: this.pendingRequests.size,
      logStreams: this.logStreams.size,
      unackedMessages: this.unackedMessages.size,
    };
  }
}
