// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { AgentTask } from "@/lib/tasks/types.js";
import type { Session } from "@/types/index.js";
import { AgentService } from "@/services/dployrd-service.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { JWTService } from "@/services/jwt.js";
import { ConnectionManager, ConnectionManagerConfig } from "./connection-manager.js";
import { AgentMessageHandler } from "./handlers/agent-handler.js";
import { ClientMessageHandler } from "./handlers/client-handler.js";
import { ClientNotifier } from "./handlers/client-notifier.js";
import { parseMessage, MessageKind, type ClusterConnection, isAckMessage } from "./message-types.js";

export interface WebSocketHandlerConfig {
  connectionManager?: Partial<ConnectionManagerConfig>;
}

/**
 * WebSocket handler for cluster streams.
 * Coordinates connection management and message routing between agents and clients.
 */
export class WebSocketHandler {
  private connectionManager: ConnectionManager;
  private dployrdHandler: AgentMessageHandler;
  private clientHandler: ClientMessageHandler;
  private clientNotifier: ClientNotifier;
  private sessionConnections = new Map<string, string>();

  constructor(private kv: IKVAdapter, private db: PostgresAdapter, config?: WebSocketHandlerConfig) {
    this.connectionManager = new ConnectionManager(config?.connectionManager);

    const kvStore = new KVStore(this.kv);
    const dbStore = new DatabaseStore(this.db);

    this.clientNotifier = new ClientNotifier(this.connectionManager, kvStore);

    // Initialize handlers with dependencies
    this.dployrdHandler = new AgentMessageHandler(this.connectionManager, this.clientNotifier, dbStore);

    const jwtService = new JWTService(kvStore);
    const dployrdService = new AgentService();

    this.clientHandler = new ClientMessageHandler({
      connectionManager: this.connectionManager,
      kv: kvStore,
      db: dbStore,
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

    // Handle reconnection for clients
    if (role === "client" && session) {
      const previousConnectionId = this.sessionConnections.get(session.userId);
      if (previousConnectionId) {
        // Replay unacked messages
        this.clientNotifier.replayUnackedMessages(clusterId, conn.connectionId);
      }
      this.sessionConnections.set(session.userId, conn.connectionId);
    }

    ws.on("message", (data) => {
      this.handleMessage(conn, data).catch((err) => {
        console.error(`[WS] Error handling message for cluster ${clusterId}:`, err);
      });
    });

    ws.on("close", () => {
      this.handleDisconnect(conn);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error on connection for cluster ${clusterId}:`, err);
      this.handleDisconnect(conn);
    });

    // Send hello message for agents
    if (role === "agent") {
      this.sendHello(ws);
    }
  }

  /**
   * Send hello message to agent on connect
   */
  private sendHello(ws: WebSocket): void {
    try {
      ws.send(JSON.stringify({
        kind: "hello",
        status: "accepted",
        timestamp: Date.now(),
      }));
    } catch (err) {
      console.error(`[WS] Failed to send hello:`, err);
    }
  }

  /**
   * Handle connection disconnect
   */
  private handleDisconnect(conn: ClusterConnection): void {
    this.connectionManager.removeConnection(conn);

    if (conn.role === "agent") {
      this.dployrdHandler.handleAgentDisconnect(conn.clusterId);
    }

    // Don't immediately remove session mapping for clients (allow reconnection)
    // Session mapping will be overwritten on reconnect
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

  /**
   * Get connection manager stats for monitoring/observability
   */
  public getStats(): ReturnType<ConnectionManager["getStats"]> {
    return this.connectionManager.getStats();
  }

  /**
   * Graceful shutdown
   */
  public shutdown(): void {
    this.connectionManager.stopCleanupLoop();
    console.log("[WS] WebSocket handler shutdown complete");
  }
}
