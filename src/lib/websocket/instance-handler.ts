// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { AgentTask } from "@/lib/tasks/types.js";
import { AgentService } from "@/services/dployrd-service.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { JWTService } from "@/services/jwt.js";
import { ConnectionManager } from "./connection-manager.js";
import { AgentMessageHandler } from "./handlers/dployrd-handler.js";
import { ClientMessageHandler } from "./handlers/client-handler.js";
import { parseMessage, MessageKind, type InstanceConnection } from "./message-types.js";

/**
 * WebSocket handler for instance streams.
 * Coordinates connection management and message routing between agents and clients.
 */
export class WebSocketHandler {
  private connectionManager: ConnectionManager;
  private dployrdHandler: AgentMessageHandler;
  private clientHandler: ClientMessageHandler;

  constructor(private kv: IKVAdapter) {
    this.connectionManager = new ConnectionManager();

    // Initialize handlers with dependencies
    this.dployrdHandler = new AgentMessageHandler(this.connectionManager, kv);

    const jwtService = new JWTService(new KVStore(this.kv));
    const dployrdService = new AgentService();

    this.clientHandler = new ClientMessageHandler({
      connectionManager: this.connectionManager,
      kv,
      jwtService,
      dployrdService,
      sendTaskToAgent: this.sendTaskToAgent.bind(this),
    });
  }

  /**
   * Register a new WebSocket connection for an instance.
   */
  acceptWebSocket(
    instanceId: string,
    ws: WebSocket,
    role: "agent" | "client"
  ): void {
    const conn = this.connectionManager.addConnection(instanceId, ws, role);

    ws.on("message", (data) => {
      this.handleMessage(conn, data).catch((err) => {
        console.error(`[WS] Error handling message for instance ${instanceId}:`, err);
      });
    });

    ws.on("close", () => {
      this.connectionManager.removeConnection(conn);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error on connection for instance ${instanceId}:`, err);
      this.connectionManager.removeConnection(conn);
    });
  }

  /**
   * Route incoming messages to the appropriate handler
   */
  private async handleMessage(conn: InstanceConnection, data: unknown): Promise<void> {
    const message = parseMessage(data);
    if (!message) {
      console.error("[WS] Invalid message format");
      return;
    }

    if (conn.role === "agent") {
      await this.dployrdHandler.handleMessage(conn, message);
    } else {
      await this.clientHandler.handleMessage(conn, message);
    }
  }

  /**
   * Send a task to the agent for this instance.
   * Returns true if the task was sent, false if no agent is connected.
   */
  public sendTaskToAgent(instanceId: string, task: AgentTask): boolean {
    const agentConn = this.connectionManager.getAgentConnection(instanceId);
    if (!agentConn) {
      console.warn(`[WS] No agent connection for instance ${instanceId}`);
      return false;
    }

    const message = {
      kind: MessageKind.TASK,
      items: [task],
    };

    try {
      agentConn.ws.send(JSON.stringify(message));
      console.log(`[WS] Sent task ${task.ID} to agent for instance ${instanceId}`);
      return true;
    } catch (err) {
      console.error(`[WS] Failed to send task to agent:`, err);
      return false;
    }
  }

  /**
   * Check if an agent is connected for the given instance.
   */
  public hasAgentConnection(instanceId: string): boolean {
    return this.connectionManager.hasAgentConnection(instanceId);
  }
}
