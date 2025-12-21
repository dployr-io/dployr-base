// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { AgentTask } from "@/lib/tasks/types.js";
import type { ConnectionManager } from "../connection-manager.js";
import type {
  ClusterConnection,
  BaseMessage,
  DeployMessage,
  LogSubscribeMessage,
  LogStreamMessage,
  FileReadMessage,
  FileWriteMessage,
  FileCreateMessage,
  FileDeleteMessage,
  FileTreeMessage,
  AckMessage,
} from "../message-types.js";
import {
  isClientSubscribeMessage,
  isDeployMessage,
  isFileReadMessage,
  isFileWriteMessage,
  isFileCreateMessage,
  isFileDeleteMessage,
  isFileTreeMessage,
  isLogSubscribeMessage,
  isLogUnsubscribeMessage,
  isLogStreamMessage,
  isAckMessage,
  validateRequestMessage,
  createWSError,
  WSErrorCode,
} from "../message-types.js";
import { AgentService } from "@/services/dployrd-service.js";
import { JWTService } from "@/services/jwt.js";
import { ulid } from "ulid";

export interface ClientHandlerDependencies {
  connectionManager: ConnectionManager;
  kv: IKVAdapter;
  jwtService: JWTService;
  dployrdService: AgentService;
  sendTaskToCluster: (clusterId: string, task: AgentTask) => boolean;
}

/**
 * Handles messages from client connections.
 */
export class ClientMessageHandler {
  private connectionManager: ConnectionManager;
  private kv: IKVAdapter;
  private jwtService: JWTService;
  private dployrdService: AgentService;
  private sendTaskToCluster: (clusterId: string, task: AgentTask) => boolean;

  constructor(deps: ClientHandlerDependencies) {
    this.connectionManager = deps.connectionManager;
    this.kv = deps.kv;
    this.jwtService = deps.jwtService;
    this.dployrdService = deps.dployrdService;
    this.sendTaskToCluster = deps.sendTaskToCluster;
  }

  /**
   * Process a message from a client
   */
  async handleMessage(
    conn: ClusterConnection,
    message: BaseMessage
  ): Promise<void> {
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

    // Validate requestId for all other operations
    if (!validateRequestMessage(message)) {
      this.sendError(conn, "", WSErrorCode.MISSING_FIELD, "requestId is required");
      return;
    }

    // Check rate limiting
    if (!this.connectionManager.canAcceptRequest(conn.ws)) {
      this.sendError(
        conn, 
        message.requestId!, 
        WSErrorCode.RATE_LIMITED, 
        `Too many pending requests (max: ${this.connectionManager.getPendingCountForClient(conn.ws)})` 
      );
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

    if (isDeployMessage(message)) {
      this.handleDeploy(conn, message);
      return;
    }

    if (isLogStreamMessage(message)) {
      await this.handleLogStream(conn, message);
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
  }

  /**
   * Send error response to client
   */
  private sendError(
    conn: ClusterConnection, 
    requestId: string, 
    code: WSErrorCode, 
    message: string,
    details?: Record<string, unknown>
  ): void {
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
    const cached = await this.kv.get(`cluster:${conn.clusterId}:status`);
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
   * Handle log stream subscription
   */
  private async handleLogSubscribe(
    conn: ClusterConnection,
    message: LogSubscribeMessage
  ): Promise<void> {
    const { instanceId, path, startOffset, limit, duration, requestId } = message;

    if (!instanceId || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and path are required");
      return;
    }

    const streamId = this.buildStreamId(
      conn.clusterId,
      path,
      startOffset,
      limit,
      duration
    );

    // Check for existing stream
    if (this.connectionManager.updateLogStreamClient(streamId, conn.ws)) {
      return;
    }

    // Create new subscription
    this.connectionManager.addLogStream({
      streamId,
      path,
      ws: conn.ws,
      startOffset,
      limit,
      duration,
    });

    // Create and send task to agents in cluster
    const token = await this.jwtService.createAgentAccessToken(instanceId);
    const task = this.dployrdService.createLogStreamTask({
      streamId,
      path,
      startOffset,
      limit,
      duration,
      token,
    });
    this.sendTaskToCluster(conn.clusterId, task);

    console.log(
      `[WS] Created log stream task ${streamId} for cluster ${conn.clusterId}`
    );
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
   * Handle deploy message
   */
  private async handleDeploy(conn: ClusterConnection, message: DeployMessage): Promise<void> {
    const { instanceId, payload, requestId } = message;

    if (!instanceId || !payload) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and payload are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required for deploy");
      return;
    }

    const taskId = ulid();
    
    // Track pending request
    const added = this.connectionManager.addPendingRequest(
      taskId,
      requestId,
      conn.ws,
      conn.clusterId,
      "deploy"
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceId,
      conn.clusterId
    );
    const task = this.dployrdService.createDeployTask(taskId, payload, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created deploy task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle log stream for deployments and services
   * path formats:
   *   - "<deployment-id>" for deployment logs
   *   - "service:<service-name>" for service logs
   */
  private async handleLogStream(
    conn: ClusterConnection,
    message: LogStreamMessage
  ): Promise<void> {
    const { token, path, streamId, duration, startFrom, requestId } = message;

    if (!token || !path || !streamId || !duration) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "token, path, streamId, and duration are required");
      return;
    }

    // Validate token
    try {
      await this.jwtService.verifyToken(token);
    } catch {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Invalid token");
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
      duration
    });

    // Create and send task to agents in cluster
    const agentToken = await this.jwtService.createAgentAccessToken(conn.clusterId);
    const task = this.dployrdService.createLogStreamTask({
      streamId,
      path,
      startOffset,
      duration,
      token: agentToken,
    });
    this.sendTaskToCluster(conn.clusterId, task);

    console.log(
      `[WS] Created log stream ${streamId} for path ${path} in cluster ${conn.clusterId}`
    );
  }

  /**
   * Handle file read request
   */
  private async handleFileRead(
    conn: ClusterConnection,
    message: FileReadMessage
  ): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and path are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(
      taskId,
      requestId,
      conn.ws,
      conn.clusterId,
      "file_read"
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceId,
      conn.clusterId
    );
    const task = this.dployrdService.createFileReadTask(taskId, path, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created file read task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file write request
   */
  private async handleFileWrite(
    conn: ClusterConnection,
    message: FileWriteMessage
  ): Promise<void> {
    const { instanceId, path, content, encoding, requestId } = message;

    if (!instanceId || !path || content === undefined) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId, path, and content are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(
      taskId,
      requestId,
      conn.ws,
      conn.clusterId,
      "file_write"
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceId,
      conn.clusterId
    );
    const task = this.dployrdService.createFileWriteTask(taskId, path, content, encoding, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created file write task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file create request
   */
  private async handleFileCreate(
    conn: ClusterConnection,
    message: FileCreateMessage
  ): Promise<void> {
    const { instanceId, path, type, requestId } = message;

    if (!instanceId || !path || !type) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId, path, and type are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(
      taskId,
      requestId,
      conn.ws,
      conn.clusterId,
      "file_create"
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceId,
      conn.clusterId
    );
    const task = this.dployrdService.createFileCreateTask(taskId, path, type, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created file create task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file delete request
   */
  private async handleFileDelete(
    conn: ClusterConnection,
    message: FileDeleteMessage
  ): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and path are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(
      taskId,
      requestId,
      conn.ws,
      conn.clusterId,
      "file_delete"
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceId,
      conn.clusterId
    );
    const task = this.dployrdService.createFileDeleteTask(taskId, path, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created file delete task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file tree request
   */
  private async handleFileTree(
    conn: ClusterConnection,
    message: FileTreeMessage
  ): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId is required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(
      taskId,
      requestId,
      conn.ws,
      conn.clusterId,
      "file_tree"
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceId,
      conn.clusterId
    );
    const task = this.dployrdService.createFileTreeTask(taskId, path, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created file tree task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Build a unique stream ID
   */
  private buildStreamId(
    clusterId: string,
    path: string,
    startOffset?: number,
    limit?: number,
    duration?: string,
  ): string {
    const offsetKey = startOffset ?? 0;
    const limitKey = limit ?? -1;
    return `${clusterId}:${path}:${offsetKey}:${limitKey}:${duration}`;
  }
}
