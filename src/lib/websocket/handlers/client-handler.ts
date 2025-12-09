// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { AgentTask } from "@/lib/tasks/types.js";
import type { ConnectionManager } from "../connection-manager.js";
import type { InstanceConnection, BaseMessage, LogSubscribeMessage } from "../message-types.js";
import { isClientSubscribeMessage, isLogSubscribeMessage, isLogUnsubscribeMessage } from "../message-types.js";
import { AgentService } from "@/services/dployrd-service.js";
import { JWTService } from "@/services/jwt.js";

export interface ClientHandlerDependencies {
  connectionManager: ConnectionManager;
  kv: IKVAdapter;
  jwtService: JWTService;
  dployrdService: AgentService;
  sendTaskToAgent: (instanceId: string, task: AgentTask) => boolean;
}

/**
 * Handles messages from client connections.
 */
export class ClientMessageHandler {
  private connectionManager: ConnectionManager;
  private kv: IKVAdapter;
  private jwtService: JWTService;
  private dployrdService: AgentService;
  private sendTaskToAgent: (instanceId: string, task: AgentTask) => boolean;

  constructor(deps: ClientHandlerDependencies) {
    this.connectionManager = deps.connectionManager;
    this.kv = deps.kv;
    this.jwtService = deps.jwtService;
    this.dployrdService = deps.dployrdService;
    this.sendTaskToAgent = deps.sendTaskToAgent;
  }

  /**
   * Process a message from a client
   */
  async handleMessage(conn: InstanceConnection, message: BaseMessage): Promise<void> {
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
  }

  /**
   * Handle client subscription - send cached status
   */
  private async handleClientSubscribe(conn: InstanceConnection): Promise<void> {
    const cached = await this.kv.get(`instance:${conn.instanceId}:status`);
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
  private async handleLogSubscribe(conn: InstanceConnection, message: LogSubscribeMessage): Promise<void> {
    const { path, startOffset, limit } = message;

    if (!path) {
      console.error("[WS] log_subscribe missing path");
      return;
    }

    const streamId = this.buildStreamId(conn.instanceId, path, startOffset, limit);

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

    // Create and send task to agent
    const token = await this.jwtService.createAgentAccessToken(conn.instanceId);
    const task = this.dployrdService.createLogStreamTask(streamId, path, startOffset, limit, token);
    this.sendTaskToAgent(conn.instanceId, task);

    console.log(`[WS] Created log stream task ${streamId} for instance ${conn.instanceId}`);
  }

  /**
   * Handle log stream unsubscription
   */
  private handleLogUnsubscribe(conn: InstanceConnection, path?: string): void {
    if (path) {
      this.connectionManager.removeLogStreamsByPath(path, conn.ws);
    }
  }

  /**
   * Build a unique stream ID
   */
  private buildStreamId(instanceId: string, path: string, startOffset?: number, limit?: number): string {
    const offsetKey = startOffset ?? 0;
    const limitKey = limit ?? -1;
    return `${instanceId}:${path}:${offsetKey}:${limitKey}`;
  }
}
