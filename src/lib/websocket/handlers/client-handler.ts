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
} from "../message-types.js";
import {
  isClientSubscribeMessage,
  isDeployMessage,
  isLogSubscribeMessage,
  isLogUnsubscribeMessage,
  isLogStreamMessage,
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
    if (isClientSubscribeMessage(message)) {
      await this.handleClientSubscribe(conn);
      return;
    }

    if (isLogSubscribeMessage(message)) {
      await this.handleLogSubscribe(conn, message);
      return;
    }

    if (isLogUnsubscribeMessage(message)) {
      this.handleLogUnsubscribe(conn, message.path);
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
  }

  /**
   * Handle client subscription - send cached status
   */
  private async handleClientSubscribe(conn: ClusterConnection): Promise<void> {
    const cached = await this.kv.get(`cluster:${conn.clusterId}:status`);
    if (cached) {
      try {
        conn.ws.send(cached);
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
    const { instanceId, path, startOffset, limit } = message;

    if (!instanceId || !path) {
      console.error("[WS] log_subscribe missing instanceId or path");
      return;
    }

    const streamId = this.buildStreamId(
      conn.clusterId,
      path,
      startOffset,
      limit
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
    });

    // Create and send task to agents in cluster
    const token = await this.jwtService.createAgentAccessToken(instanceId);
    const task = this.dployrdService.createLogStreamTask(
      streamId,
      path,
      startOffset,
      limit,
      token
    );
    this.sendTaskToCluster(conn.clusterId, task);

    console.log(
      `[WS] Created log stream task ${streamId} for cluster ${conn.clusterId}`
    );
  }

  /**
   * Handle log stream unsubscription
   */
  private handleLogUnsubscribe(conn: ClusterConnection, path?: string): void {
    if (path) {
      this.connectionManager.removeLogStreamsByPath(path, conn.ws);
    }
  }

  /**
   * Handle deploy message
   */
  private async handleDeploy(conn: ClusterConnection, message: DeployMessage): Promise<void> {
    const { instanceId, payload } = message;

    if (!instanceId || !payload) {
      console.error("[WS] deploy message missing instanceId or payload");
      return;
    }

    if (!conn.session) {
      console.error("[WS] deploy message missing session");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(
      conn.session,
      instanceId,
      conn.clusterId
    );
    const taskId = ulid();
    const task = this.dployrdService.createDeployTask(taskId, payload, token);
    const sent = this.sendTaskToCluster(conn.clusterId, task);

    if (!sent) {
      console.warn(`[WS] Failed to send deploy task ${taskId} to cluster ${conn.clusterId}`);
    }

    console.log(
      `[WS] Created deploy task ${taskId} for cluster ${conn.clusterId}`
    );
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
    const { token, path, streamId, mode, startFrom } = message;

    if (!token || !path || !streamId) {
      console.error("[WS] log_stream missing required fields (token, path, or streamId)");
      return;
    }

    // Validate token
    try {
      await this.jwtService.verifyToken(token);
    } catch {
      console.error("[WS] log_stream invalid token");
      conn.ws.send(JSON.stringify({ error: "invalid_token", streamId }));
      return;
    }

    // Check for existing stream and reuse if possible
    if (this.connectionManager.updateLogStreamClient(streamId, conn.ws)) {
      return;
    }

    // Create new subscription
    const startOffset = startFrom === -1 ? undefined : startFrom;
    const limit = mode === "tail" ? undefined : 1000;

    this.connectionManager.addLogStream({
      streamId,
      path,
      ws: conn.ws,
      startOffset,
      limit,
    });

    // Create and send task to agents in cluster
    const agentToken = await this.jwtService.createAgentAccessToken(conn.clusterId);
    const task = this.dployrdService.createLogStreamTask(
      streamId,
      path,
      startOffset,
      limit,
      agentToken
    );
    this.sendTaskToCluster(conn.clusterId, task);

    console.log(
      `[WS] Created log stream ${streamId} for path ${path} in cluster ${conn.clusterId}`
    );
  }

  /**
   * Build a unique stream ID
   */
  private buildStreamId(
    clusterId: string,
    path: string,
    startOffset?: number,
    limit?: number
  ): string {
    const offsetKey = startOffset ?? 0;
    const limitKey = limit ?? -1;
    return `${clusterId}:${path}:${offsetKey}:${limitKey}`;
  }
}
