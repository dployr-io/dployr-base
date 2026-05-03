// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Instance } from "@/types/index.js";
import type { ConnectionManager } from "../connection-manager.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import type {
  ClusterConnection,
  BaseMessage,
  LogSubscribeMessage,
  FileReadMessage,
  FileWriteMessage,
  FileCreateMessage,
  FileDeleteMessage,
  FileTreeMessage,
  AckMessage,
  FileWatchMessage,
  FileUnwatchMessage,
  ProcessHistoryMessage,
  ProcessHistoryResponseMessage,
  TerminalMessage,
  TerminalOpenMessage,
} from "../../../types/websocket-message.js";
import {
  isClientSubscribeMessage,
  isFileReadMessage,
  isFileWriteMessage,
  isFileCreateMessage,
  isFileDeleteMessage,
  isFileTreeMessage,
  isLogSubscribeMessage,
  isLogUnsubscribeMessage,
  isAckMessage,
  isFileWatchMessage,
  isFileUnwatchMessage,
  validateRequestMessage,
  createWSError,
  isProcessHistoryMessage,
  isTerminalMessage,
  isTerminalOpenMessage,
} from "../../../types/websocket-message.js";
import { DployrdService } from "@/services/dployrd.js";
import { JWTService } from "@/services/auth/jwt.js";
import { ulid } from "ulid";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { TerminalManager } from "@/services/websocket/terminal-manager.js";
import { WSErrorCode } from "@/lib/constants/websocket.js";
import { ALLOWED_TASKS_ON_POOLED_INSTANCES } from "@/lib/constants/instances.js";

export interface ClientHandlerDependencies {
  connectionManager: ConnectionManager;
  kv: KVStore;
  db: DatabaseStore;
  jwtService: JWTService;
  dployrdService: DployrdService;
  terminalManager: TerminalManager;
}

/**
 * Handles messages from client connections.
 */
export class ClientMessageHandler {
  private kv: KVStore;
  private db: DatabaseStore;
  private jwtService: JWTService;
  private dployrdService: DployrdService;
  private terminalManager: TerminalManager;
  private connectionManager: ConnectionManager;

  constructor(deps: ClientHandlerDependencies) {
    this.connectionManager = deps.connectionManager;
    this.kv = deps.kv;
    this.db = deps.db;
    this.jwtService = deps.jwtService;
    this.dployrdService = deps.dployrdService;
    this.terminalManager = deps.terminalManager;
  }

  /**
   * Check if a task is allowed on an instance
   */
  private isTaskAllowedOnInstance(instance: Instance, message: BaseMessage): boolean {
    if (instance.kind !== "pool") return true;
    const kind = message.kind;
    return ALLOWED_TASKS_ON_POOLED_INSTANCES.some((allowed) => (allowed.endsWith(":") ? kind.startsWith(allowed) : kind === allowed));
  }

  /**
   * Process a message from a client
   */
  async handleMessage(conn: ClusterConnection, message: BaseMessage): Promise<void> {
    // Update activity timestamp
    this.connectionManager.updateActivity(conn.ws);

    // Handle acknowledgments
    if (isAckMessage(message)) {
      this.handleAck(message);
      return;
    }

    // Handle client subscribe (no requestId required)
    if (isClientSubscribeMessage(message)) {
      await this.handleClientSubscribe(conn, message.requestId);
      return;
    }

    if (isLogSubscribeMessage(message)) {
      await this.handleLogSubscribe(conn, message);
      return;
    }

    if (isLogUnsubscribeMessage(message)) {
      this.handleLogUnsubscribe(conn, message.path, message.requestId!);
      return;
    }

    // Validate requestId for all other operations
    if (!validateRequestMessage(message)) {
      this.sendError(conn, "", WSErrorCode.MISSING_FIELD, "requestId is required");
      return;
    }

    // Check rate limiting
    if (!this.connectionManager.canAcceptRequest(conn.ws)) {
      this.sendError(conn, message.requestId!, WSErrorCode.RATE_LIMITED, `Too many pending requests (max: ${this.connectionManager.getPendingCountForClient(conn.ws)})`);
      return;
    }

    if (isFileReadMessage(message)) {
      await this.handleFileRead(conn, message);
      return;
    }

    if (isFileWriteMessage(message)) {
      await this.handleFileWrite(conn, message);
      return;
    }

    if (isFileCreateMessage(message)) {
      await this.handleFileCreate(conn, message);
      return;
    }

    if (isFileDeleteMessage(message)) {
      await this.handleFileDelete(conn, message);
      return;
    }

    if (isFileTreeMessage(message)) {
      await this.handleFileTree(conn, message);
      return;
    }

    if (isFileWatchMessage(message)) {
      await this.handleFileWatch(conn, message);
      return;
    }

    if (isFileUnwatchMessage(message)) {
      await this.handleFileUnwatch(conn, message);
      return;
    }

    if (isProcessHistoryMessage(message)) {
      await this.handleProcessHistory(conn, message);
      return;
    }

    if (isTerminalOpenMessage(message)) {
      await this.handleTerminalOpen(conn, message);
      return;
    }

    if (isTerminalMessage(message)) {
      await this.handleTerminal(conn, message);
      return;
    }
  }

  /**
   * Send error response to client
   */
  private sendError(conn: ClusterConnection, requestId: string, code: WSErrorCode, message: string, details?: Record<string, unknown>): void {
    try {
      const error = createWSError(requestId, code, message, details);
      conn.ws.send(JSON.stringify(error));
    } catch (err) {
      console.error(`[WS] Failed to send error to client:`, err);
    }
  }

  /**
   * Handle acknowledgment messages
   */
  private handleAck(message: AckMessage): void {
    const { messageId } = message;
    if (messageId) {
      this.connectionManager.acknowledgeMessage(messageId);
    }
  }

  /**
   * Handle client subscription - send cached status
   */
  private async handleClientSubscribe(conn: ClusterConnection, requestId?: string): Promise<void> {
    const cached = await this.kv.kv.get(`cluster:${conn.connectionKey}:status`);
    if (cached) {
      try {
        const response = {
          ...JSON.parse(cached),
          requestId,
        };
        conn.ws.send(JSON.stringify(response));
      } catch (err) {
        console.error(`[WS] Failed to send cached status:`, err);
      }
    }
  }

  /**
   * Handle log stream for deployments and services
   * path formats:
   *   - "<deployment-id>" for deployment logs
   *   - "service:<service-name>" for service logs
   */
  private async handleLogSubscribe(conn: ClusterConnection, message: LogSubscribeMessage): Promise<void> {
    const { path, streamId, duration, startFrom } = message;

    if (!path || !streamId || !duration) {
      this.sendError(conn, streamId, WSErrorCode.MISSING_FIELD, "token, path, streamId, and duration are required");
      return;
    }

    // Check for existing stream and reuse if possible
    if (this.connectionManager.updateLogStreamClient(streamId, conn.ws)) {
      return;
    }

    // Create new subscription
    const startOffset = startFrom === -1 ? undefined : startFrom;

    this.connectionManager.addLogStream({
      streamId,
      path,
      ws: conn.ws,
      startOffset,
      duration,
    });

    // Find which instance has the deployment/service by checking NODE_UPDATE in KV
    let instance = await this.findInstanceWithWorkload(conn.connectionKey, path);

    if (!instance) {
      console.error(`[ConnectionManager] No instance found with deployment/service at path ${path}`);
      this.sendError(conn, streamId, WSErrorCode.INTERNAL_ERROR, "Deployment or service not found on any instance");
      return;
    }

    // Create and send task to nodes in cluster
    const nodeToken = await this.jwtService.createNodeAccessToken(instance.tag);
    const task = this.dployrdService.createLogStreamTask({
      streamId,
      path,
      startOffset,
      duration,
      token: nodeToken,
    });

    // Determine routing key based on instance type
    const routingKey = instance.kind === "pool" ? `pool:${instance.tag}` : instance.tag;
    const sent = this.connectionManager.sendTask(routingKey, task);

    if (!sent) {
      console.error(`[ClientMessageHandler] Failed to send log task - no node connections for routing key ${routingKey}`);
    }

    console.log(`[WS] Created log stream ${streamId} for path ${path} in cluster ${conn.connectionKey}`);
  }

  /**
   * Find which instance has the deployment/service by checking NODE_UPDATE in KV
   */
  private async findInstanceWithWorkload(clusterId: string, path: string): Promise<Instance | null> {
    const instances: Instance[] = [];
    const dedicated = await this.db.instances.find({ clusterId });
    if (dedicated) instances.push(dedicated);

    const poolInstanceId = await this.db.instances.getClusterPoolInstance(clusterId);
    if (poolInstanceId) {
      const pool = await this.db.instances.find({ id: poolInstanceId });
      if (pool) instances.push(pool);
    }

    for (const instance of instances) {
      const updateJson = await this.kv.kv.get(`node:${instance.tag}:update`);
      if (!updateJson) continue;

      try {
        const update = JSON.parse(updateJson);
        const workloads = update.workloads;
        const isDeployment = workloads?.deployments?.some((d: any) => d.id === path);
        const isService = path.startsWith("service:") && workloads?.services?.some((s: any) => s.name === path.slice(8));

        if (isDeployment || isService) {
          return instance;
        }
      } catch (err) {
        console.error(`[ClientMessageHandler] Failed to parse NODE_UPDATE for ${instance.tag}:`, err);
      }
    }

    return null;
  }

  /**
   * Handle log stream unsubscription
   */
  private handleLogUnsubscribe(conn: ClusterConnection, path: string | undefined, requestId: string): void {
    if (path) {
      this.connectionManager.removeLogStreamsByPath(path, conn.ws);
    }
    // Send acknowledgment
    try {
      conn.ws.send(JSON.stringify({ kind: "log_unsubscribe_response", requestId, success: true }));
    } catch {}
  }

  /**
   * Handle file read request
   */
  private async handleFileRead(conn: ClusterConnection, message: FileReadMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and path are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_read");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileReadTask(taskId, path, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    console.log(`[WS] Created file read task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file write request
   */
  private async handleFileWrite(conn: ClusterConnection, message: FileWriteMessage): Promise<void> {
    const { instanceId, path, content, encoding, requestId } = message;

    if (!instanceId || !path || content === undefined) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId, path, and content are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_write");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileWriteTask(taskId, path, content, encoding, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    console.log(`[WS] Created file write task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file create request
   */
  private async handleFileCreate(conn: ClusterConnection, message: FileCreateMessage): Promise<void> {
    const { instanceId, path, type, requestId } = message;

    if (!instanceId || !path || !type) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId, path, and type are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_create");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileCreateTask(taskId, path, type, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    console.log(`[WS] Created file create task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file delete request
   */
  private async handleFileDelete(conn: ClusterConnection, message: FileDeleteMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and path are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_delete");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileDeleteTask(taskId, path, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    console.log(`[WS] Created file delete task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file tree request
   */
  private async handleFileTree(conn: ClusterConnection, message: FileTreeMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId is required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_tree");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileTreeTask(taskId, path, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    console.log(`[WS] Created file tree task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Build a unique stream ID
   */
  private buildStreamId(clusterId: string, path: string, startOffset?: number, limit?: number, duration?: string): string {
    const offsetKey = startOffset ?? 0;
    const limitKey = limit ?? -1;
    return `${clusterId}:${path}:${offsetKey}:${limitKey}:${duration}`;
  }

  /**
   * Handle file watch request
   */
  private async handleFileWatch(conn: ClusterConnection, message: FileWatchMessage): Promise<void> {
    const { instanceId, path, recursive = false, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const watchKey = `${instanceId}:${path}`;
    this.connectionManager.addFileWatch(watchKey, conn.connectionId);

    const taskId = ulid();
    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);

    const task = this.dployrdService.createFileWatchTask(taskId, instanceId, path, recursive, requestId, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removeFileWatch(watchKey, conn.connectionId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);
    if (!sent) {
      this.connectionManager.removeFileWatch(watchKey, conn.connectionId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    conn.ws.send(
      JSON.stringify({
        kind: "file_watch_response",
        requestId,
        taskId,
        success: true,
        data: { path, recursive },
      }),
    );
  }

  /**
   * Handle file unwatch request
   */
  private async handleFileUnwatch(conn: ClusterConnection, message: FileUnwatchMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const watchKey = `${instanceId}:${path}`;
    this.connectionManager.removeFileWatch(watchKey, conn.connectionId);

    // Only send unwatch task to node if no more subscribers
    if (!this.connectionManager.hasFileWatchSubscribers(watchKey)) {
      const taskId = ulid();
      const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
      const task = this.dployrdService.createFileUnwatchTask(taskId, instanceId, path, requestId, token);

      if (this.isTaskAllowedOnInstance(instance, message)) {
        this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);
      }
    }

    conn.ws.send(
      JSON.stringify({
        kind: "file_unwatch_response",
        requestId,
        taskId: ulid(),
        success: true,
        data: { path },
      }),
    );
  }

  /**
   * Handle terminal open request - sends task to node to initiate outbound WebSocket
   */
  private async handleTerminalOpen(conn: ClusterConnection, message: TerminalOpenMessage): Promise<void> {
    const { instanceId, requestId, cols, rows } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const clusterId = instance.kind === "pool" ? conn.connectionKey : instance.clusterId;
    if (!clusterId) {
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "Permission denied");
      return;
    }

    const userClusters = conn.session.clusters.map((c) => c.id);
    if (!userClusters.includes(clusterId)) {
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "Permission denied");
      return;
    }

    const sessionId = `${instanceId}:${ulid()}`;
    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, clusterId);

    this.terminalManager.expectSession(sessionId, conn.ws, instanceId);

    const taskId = ulid();
    const task = this.dployrdService.createTerminalOpen(taskId, sessionId, cols, rows, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.terminalManager.removeExpectedSession(sessionId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);
    if (!sent) {
      this.terminalManager.removeExpectedSession(sessionId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No node available");
      return;
    }
  }

  /**
   * Handle terminal I/O messages - relay through established session
   */
  private async handleTerminal(conn: ClusterConnection, message: TerminalMessage): Promise<void> {
    const { requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    this.terminalManager.handleClientMessage(conn.ws, message);
  }

  /**
   * Handle process history request
   */
  private async handleProcessHistory(conn: ClusterConnection, message: ProcessHistoryMessage): Promise<void> {
    const { instanceId, startTime, endTime, requestId } = message;

    if (!requestId) {
      console.warn("[WS] Process history request missing requestId");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    try {
      const instance = await this.db.instances.find({ tag: instanceId });

      if (!instance) {
        this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
        return;
      }

      // Verify user has access to this instance's cluster
      const effectiveClusterId = instance.kind === "pool" ? conn.connectionKey : instance.clusterId;
      const userClusters = conn.session.clusters.map((c) => c.id);
      if (!effectiveClusterId || !userClusters.includes(effectiveClusterId)) {
        this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "Permission denied");
        return;
      }

      // Calculate time range (default: last 1 hour)
      const now = Date.now();
      const start = startTime || now - 60 * 60 * 1000; // 1 hour ago
      const end = endTime || now;

      // Retrieve process snapshots for the time range
      const snapshots = await this.kv.getProcessSnapshotsByTimeRange({ tag: instanceId, startTime: start, endTime: end });

      const response: ProcessHistoryResponseMessage = {
        kind: "process_history_response",
        requestId,
        success: true,
        data: {
          snapshots,
        },
      };

      conn.ws.send(JSON.stringify(response));
      console.log(`[WS] Retrieved ${snapshots.length} process snapshots for ${instanceId} (requestId: ${requestId})`);
    } catch (error) {
      console.error(`[WS] Failed to retrieve process history for ${instanceId}:`, error);
      this.sendError(conn, requestId, WSErrorCode.INTERNAL_ERROR, "Failed to retrieve process history");
    }
  }
}
