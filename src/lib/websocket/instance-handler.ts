// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { AgentTask } from "@/lib/tasks/types.js";
import type { Session } from "@/types/index.js";
import { AgentService } from "@/services/dployrd-service.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { JWTService } from "@/services/jwt.js";
import { ConnectionManager } from "./connection-manager.js";
import { AgentMessageHandler } from "./handlers/agent-handler.js";
import { ClientMessageHandler } from "./handlers/client-handler.js";
import { ClientNotifier } from "./handlers/client-notifier.js";
import { parseMessage, MessageKind, type ClusterConnection } from "./message-types.js";

/**
 * WebSocket handler for cluster streams.
 * Coordinates connection management and message routing between agents and clients.
 */
export class WebSocketHandler {
  private connectionManager: ConnectionManager;
  private dployrdHandler: AgentMessageHandler;
  private clientHandler: ClientMessageHandler;

  constructor(private kv: IKVAdapter) {
    this.connectionManager = new ConnectionManager();

    const clientNotifier = new ClientNotifier(this.connectionManager, kv);

    // Initialize handlers with dependencies
    this.dployrdHandler = new AgentMessageHandler(this.connectionManager, clientNotifier);

    const jwtService = new JWTService(new KVStore(this.kv));
    const dployrdService = new AgentService();

    this.clientHandler = new ClientMessageHandler({
      connectionManager: this.connectionManager,
      kv,
      jwtService,
      dployrdService,
      sendTaskToCluster: this.sendTaskToCluster.bind(this),
    });
  }

  /**
   * Register a new WebSocket connection for a cluster.
   * @param clusterId - The cluster to connect to
   * @param ws - The WebSocket connection
   * @param role - Whether this is an agent or client connection
   * @param session - Optional session (for client connections)
   */
  acceptWebSocket(
    clusterId: string,
    ws: WebSocket,
    role: "agent" | "client",
    session?: Session
  ): void {
    const conn = this.connectionManager.addConnection(clusterId, ws, role, session);

    ws.on("message", (data) => {
      this.handleMessage(conn, data).catch((err) => {
        console.error(`[WS] Error handling message for cluster ${clusterId}:`, err);
      });
    });

    ws.on("close", () => {
      this.connectionManager.removeConnection(conn);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error on connection for cluster ${clusterId}:`, err);
      this.connectionManager.removeConnection(conn);
    });
  }

  /**
   * Route incoming messages to the appropriate handler
   */
  private async handleMessage(conn: ClusterConnection, data: unknown): Promise<void> {
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
   * Send a task to all agents in a cluster.
   * Returns true if the task was sent to at least one agent.
   */
  public sendTaskToCluster(clusterId: string, task: AgentTask): boolean {
    const agentConns = this.connectionManager.getAgentConnections(clusterId);
    if (agentConns.length === 0) {
      console.warn(`[WS] No agent connections for cluster ${clusterId}`);
      return false;
    }

    const message = {
      kind: MessageKind.TASK,
      items: [task],
    };

    const payload = JSON.stringify(message);
    let sentCount = 0;

    for (const agentConn of agentConns) {
      try {
        agentConn.ws.send(payload);
        sentCount++;
      } catch (err) {
        console.error(`[WS] Failed to send task to agent:`, err);
      }
    }

    console.log(`[WS] Sent task ${task.ID} to ${sentCount}/${agentConns.length} agents in cluster ${clusterId}`);
    return sentCount > 0;
  }

  /**
   * Check if any agent is connected for the given cluster.
   */
  public hasAgentConnection(clusterId: string): boolean {
    return this.connectionManager.hasAgentConnection(clusterId);
  }
}
