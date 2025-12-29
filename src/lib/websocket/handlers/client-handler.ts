// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { AgentTask } from "@/lib/tasks/types.js";
import type { ConnectionManager } from "../connection-manager.js";
import { KVStore } from "@/lib/db/store/kv.js";
import type {
  ClusterConnection,
  BaseMessage,
  DeployMessage,
  DeploymentListMessage,
  LogSubscribeMessage,
  LogStreamMessage,
  FileReadMessage,
  FileWriteMessage,
  FileCreateMessage,
  FileDeleteMessage,
  FileTreeMessage,
  AckMessage,
  InstanceTokenRotateMessage,
  InstanceSystemInstallMessage,
  InstanceSystemRebootMessage,
  InstanceSystemRestartMessage,
  FileWatchMessage,
  FileUnwatchMessage,
  ServiceRemoveMessage,
} from "../message-types.js";
import {
  isClientSubscribeMessage,
  isDeployMessage,
  isDeploymentListMessage,
  isFileReadMessage,
  isFileWriteMessage,
  isFileCreateMessage,
  isFileDeleteMessage,
  isFileTreeMessage,
  isLogSubscribeMessage,
  isLogUnsubscribeMessage,
  isLogStreamMessage,
  isAckMessage,
  isInstanceTokenRotateMessage,
  isInstanceSystemInstallMessage,
  isInstanceSystemRebootMessage,
  isInstanceSystemRestartMessage,
  isFileWatchMessage,
  isFileUnwatchMessage,
  validateRequestMessage,
  createWSError,
  WSErrorCode,
  MessageKind,
  isServiceRemoveMessage,
} from "../message-types.js";
import { AgentService } from "@/services/dployrd-service.js";
import { JWTService } from "@/services/jwt.js";
import { ulid } from "ulid";
import { DatabaseStore } from "@/lib/db/store/index.js";

export interface ClientHandlerDependencies {
  connectionManager: ConnectionManager;
  kv: KVStore;
  db: DatabaseStore;
  jwtService: JWTService;
  dployrdService: AgentService;
  sendTaskToCluster: (clusterId: string, task: AgentTask) => boolean;
}

/**
 * Handles messages from client connections.
 */
export class ClientMessageHandler {
  private connectionManager: ConnectionManager;
  private kv: KVStore;
  private db: DatabaseStore;
  private jwtService: JWTService;
  private dployrdService: AgentService;
  private sendTaskToCluster: (clusterId: string, task: AgentTask) => boolean;

  constructor(deps: ClientHandlerDependencies) {
    this.connectionManager = deps.connectionManager;
    this.kv = deps.kv;
    this.db = deps.db;
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

    if (isDeploymentListMessage(message)) {
      await this.handleDeploymentList(conn, message);
      return;
    }

    if (isServiceRemoveMessage(message)) {
      this.handleServiceRemove(conn, message);
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

    if (isInstanceTokenRotateMessage(message)) {
      await this.handleInstanceTokenRotate(conn, message);
      return;
    }

    if (isInstanceSystemInstallMessage(message)) {
      await this.handleInstanceSystemInstall(conn, message);
      return;
    }

    if (isInstanceSystemRebootMessage(message)) {
      await this.handleInstanceSystemReboot(conn, message);
      return;
    }

    if (isInstanceSystemRestartMessage(message)) {
      await this.handleInstanceSystemRestart(conn, message);
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
    const cached = await this.kv.kv.get(`cluster:${conn.clusterId}:status`);
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
    const { instanceName, path, startOffset, limit, duration, requestId } = message;

    if (!instanceName || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceName and path are required");
      return;
    }

    const instance = await this.db.instances.getByName(instanceName);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
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
    const token = await this.jwtService.createAgentAccessToken(instance.tag);
    const task = this.dployrdService.createLogStreamTask({
      streamId,
      path,
      startOffset,
      limit,
      duration,
      token,
    });
    this.sendTaskToCluster(conn.clusterId, task);

    console.log("Token", token)

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
    } catch { }
  }

  /**
   * Handle deploy message
   */
  private async handleDeploy(conn: ClusterConnection, message: DeployMessage): Promise<void> {
    const { instanceName, payload, requestId } = message;

    if (!instanceName || !payload) {
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
      MessageKind.DEPLOY,
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const instance = await this.db.instances.getByName(instanceName);

    if (!instance) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "No instance with matching name was found!");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceName,
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
   * Handle deployment list request 
   */
  private async handleDeploymentList(conn: ClusterConnection, message: DeploymentListMessage): Promise<void> {
    const { instanceName, requestId } = message;

    if (!instanceName) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceName is required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const taskId = ulid();

    const added = this.connectionManager.addPendingRequest(
      taskId,
      requestId,
      conn.ws,
      conn.clusterId,
      MessageKind.DEPLOYMENT_LIST,
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceName,
      conn.clusterId
    );
    const task = this.dployrdService.createDeploymentListTask(taskId, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created deployment list task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle service remove
   */
  private async handleServiceRemove(conn: ClusterConnection, message: ServiceRemoveMessage): Promise<void> {
    const { name, requestId } = message;

    if (!name || !requestId) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "name and requestId is required");
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
      MessageKind.SERVICE_REMOVE,
    );

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const service = await this.db.services.getByName(name);
    
    if (!service) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, `Service '${name}' not found`);
      return;
    }

    const instance = await this.db.instances.get(service.instanceId);
    if (!instance) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instance.tag,
      conn.clusterId
    );
    const task = this.dployrdService.createServiceRemoveTask(taskId, service.name, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    console.log(`[WS] Created service remove task ${taskId} (requestId: ${requestId})`);  
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

    const instance = await this.db.instances.get(instanceId);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
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

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.clusterId);
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

    const instance = await this.db.instances.get(instanceId);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
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

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.clusterId);
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

    const instance = await this.db.instances.get(instanceId);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
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

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.clusterId);
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

    const instance = await this.db.instances.get(instanceId);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
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

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.clusterId);
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

    const instance = await this.db.instances.get(instanceId);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
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

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.clusterId);
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

  /**
   * Handle instance token rotate request
   */
  private async handleInstanceTokenRotate(
    conn: ClusterConnection,
    message: InstanceTokenRotateMessage
  ): Promise<void> {
    const { instanceName, token, requestId } = message;

    try {
      const instance = await this.db.instances.getByName(instanceName);
      if (!instance) {
        this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
        return;
      }

      let payload: any;
      try {
        payload = await this.jwtService.verifyTokenIgnoringExpiry(token);
      } catch {
        this.sendError(conn, requestId, WSErrorCode.VALIDATION_ERROR, "Invalid token signature");
        return;
      }

      if (payload.token_type !== "bootstrap" || payload.instance_id !== instance.id) {
        this.sendError(conn, requestId, WSErrorCode.VALIDATION_ERROR, "Invalid bootstrap token for instance");
        return;
      }

      const nonce = payload.nonce as string | undefined;
      if (!nonce) {
        this.sendError(conn, requestId, WSErrorCode.VALIDATION_ERROR, "Invalid bootstrap token payload");
        return;
      }

      const rotated = await this.jwtService.rotateBootstrapToken(instance.id, nonce, "5m");

      conn.ws.send(JSON.stringify({
        kind: "instance_token_rotate_response",
        requestId,
        success: true,
        data: {
          token: rotated,
        },
      }));
    } catch (error) {
      console.error("[WS] Failed to rotate token:", error);
      this.sendError(conn, requestId, WSErrorCode.INTERNAL_ERROR, "Failed to rotate token");
    }
  }

  /**
   * Handle instance system install request
   */
  private async handleInstanceSystemInstall(
    conn: ClusterConnection,
    message: InstanceSystemInstallMessage
  ): Promise<void> {
    const { instanceName, clusterId, version, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    try {
      const instance = await this.db.instances.getByName(instanceName);

      if (!instance) {
        this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
        return;
      }

      if (instance.clusterId !== clusterId) {
        this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "Permission denied");
        return;
      }

      const taskId = ulid();
      const token = await this.jwtService.createInstanceAccessToken(
        conn.session,
        instanceName,
        clusterId
      );
      const task = this.dployrdService.createSystemInstallTask(taskId, version, token);

      const sent = this.sendTaskToCluster(clusterId, task);
      if (!sent) {
        this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
        return;
      }

      conn.ws.send(JSON.stringify({
        kind: "instance_system_install_response",
        requestId,
        success: true,
        data: {
          status: "accepted",
          taskId,
          message: version
            ? `Install task sent for version ${version}`
            : "Install task sent for latest version",
        },
      }));
    } catch (error) {
      console.error("[WS] Failed to send system install task:", error);
      this.sendError(conn, requestId, WSErrorCode.INTERNAL_ERROR, "Failed to send system install task");
    }
  }

  /**
   * Handle instance system reboot request
   */
  private async handleInstanceSystemReboot(
    conn: ClusterConnection,
    message: InstanceSystemRebootMessage
  ): Promise<void> {
    const { instanceName, clusterId, force = false, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    try {
      const instance = await this.db.instances.getByName(instanceName);

      if (!instance) {
        this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
        return;
      }

      if (instance.clusterId !== clusterId) {
        this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "Permission denied");
        return;
      }

      const taskId = ulid();
      const token = await this.jwtService.createInstanceAccessToken(
        conn.session,
        instanceName,
        clusterId
      );
      const task = this.dployrdService.createSystemRebootTask(taskId, force, token);

      const sent = this.sendTaskToCluster(clusterId, task);
      if (!sent) {
        this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
        return;
      }

      conn.ws.send(JSON.stringify({
        kind: "instance_system_reboot_response",
        requestId,
        success: true,
        data: {
          status: "accepted",
          taskId,
          message: force
            ? "Reboot task sent (force mode - bypassing pending tasks check)"
            : "Reboot task sent (will wait for pending tasks to complete)",
        },
      }));
    } catch (error) {
      console.error("[WS] Failed to send system reboot task:", error);
      this.sendError(conn, requestId, WSErrorCode.INTERNAL_ERROR, "Failed to send system reboot task");
    }
  }

  /**
   * Handle file watch request
   */
  private async handleFileWatch(
    conn: ClusterConnection,
    message: FileWatchMessage
  ): Promise<void> {
    const { instanceId, path, recursive = false, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.get(instanceId);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const watchKey = `${instanceId}:${path}`;
    this.connectionManager.addFileWatch(watchKey, conn.connectionId);

    const taskId = ulid();
    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.clusterId);

    const task = this.dployrdService.createFileWatchTask(
      taskId,
      instanceId,
      path,
      recursive,
      requestId,
      token
    );

    const sent = this.sendTaskToCluster(conn.clusterId, task);
    if (!sent) {
      this.connectionManager.removeFileWatch(watchKey, conn.connectionId);
      this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
      return;
    }

    conn.ws.send(JSON.stringify({
      kind: "file_watch_response",
      requestId,
      taskId,
      success: true,
      data: { path, recursive },
    }));
  }

  /**
   * Handle file unwatch request
   */
  private async handleFileUnwatch(
    conn: ClusterConnection,
    message: FileUnwatchMessage
  ): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.get(instanceId);
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const watchKey = `${instanceId}:${path}`;
    this.connectionManager.removeFileWatch(watchKey, conn.connectionId);

    // Only send unwatch task to agent if no more subscribers
    if (!this.connectionManager.hasFileWatchSubscribers(watchKey)) {
      const taskId = ulid();
      const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.clusterId);

      const task = this.dployrdService.createFileUnwatchTask(
        taskId,
        instanceId,
        path,
        requestId,
        token
      );

      this.sendTaskToCluster(conn.clusterId, task);
    }

    conn.ws.send(JSON.stringify({
      kind: "file_unwatch_response",
      requestId,
      taskId: ulid(),
      success: true,
      data: { path },
    }));
  }

  /**
   * Handle instance system restart request
   */
  private async handleInstanceSystemRestart(
    conn: ClusterConnection,
    message: InstanceSystemRestartMessage
  ): Promise<void> {
    const { instanceName, clusterId, force = false, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    try {
      const instance = await this.db.instances.getByName(instanceName);

      if (!instance) {
        this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
        return;
      }

      if (instance.clusterId !== clusterId) {
        this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "Permission denied");
        return;
      }

      const taskId = ulid();
      const token = await this.jwtService.createInstanceAccessToken(
        conn.session,
        instanceName,
        clusterId
      );
      const task = this.dployrdService.createDaemonRestartTask(taskId, force, token);

      const sent = this.sendTaskToCluster(clusterId, task);
      if (!sent) {
        this.sendError(conn, requestId, WSErrorCode.AGENT_DISCONNECTED, "No agents available");
        return;
      }

      conn.ws.send(JSON.stringify({
        kind: "instance_system_restart_response",
        requestId,
        success: true,
        data: {
          status: "accepted",
          taskId,
          message: force
            ? "Restart task sent (force mode - bypassing pending tasks check)"
            : "Restart task sent (will wait for pending tasks to complete)",
        },
      }));
    } catch (error) {
      console.error("[WS] Failed to send system restart task:", error);
      this.sendError(conn, requestId, WSErrorCode.INTERNAL_ERROR, "Failed to send system restart task");
    }
  }
}
