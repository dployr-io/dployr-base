// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { NodeTask } from "@/lib/tasks/types.js";
import type { ConnectionManagerConfig, Session } from "@/types/index.js";
import { DployrdService } from "@/services/dployrd.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { JWTService } from "@/services/auth/jwt.js";
import { ConnectionManager } from "./connection-manager.js";
import { NodeMessageHandler } from "./handlers/node-handler.js";
import { ClientMessageHandler } from "./handlers/client-handler.js";
import { ClientNotifier } from "./handlers/client-notifier.js";
import { TerminalManager } from "./terminal-manager.js";
import { parseMessage, type ClusterConnection } from "@/types/websocket-message.js";
import type { BillingProvider } from "@/services/billing/provider.js";
import { MESSAGE_KIND } from "@/lib/constants/websocket.js";
import { Logger } from "@/lib/logger.js";
import { worker } from "@/services/background/index.js";
import { NODES_HEALTH_JOB, NODES_SYNC_JOB } from "@/lib/constants/index.js";

export interface WebSocketHandlerConfig {
  connectionManager?: Partial<ConnectionManagerConfig>;
  billingProvider?: BillingProvider | null;
}

/**
 * WebSocket handler for cluster streams.
 * Coordinates connection management and message routing between nodes and clients.
 */
export class WebSocketHandler {
  public readonly connectionManager: ConnectionManager;
  public readonly clientNotifier: ClientNotifier;
  private dployrdHandler: NodeMessageHandler;
  private clientHandler: ClientMessageHandler;
  private terminalManager: TerminalManager;
  private sessionConnections = new Map<string, string>();
  private dbStore: DatabaseStore;

  private kvStore: KVStore;
  private log = new Logger("WebSocket");

  constructor(
    private kv: IKVAdapter,
    private db: PostgresAdapter,
    config?: WebSocketHandlerConfig,
  ) {
    this.connectionManager = new ConnectionManager(config?.connectionManager);

    this.kvStore = new KVStore(this.kv);
    this.dbStore = new DatabaseStore(this.db);

    this.clientNotifier = new ClientNotifier(this.connectionManager, this.kvStore);

    const jwtService = new JWTService(this.kvStore);
    const dployrdService = new DployrdService();

    this.dployrdHandler = new NodeMessageHandler(this.connectionManager, this.clientNotifier, this.dbStore, this.kvStore, jwtService);

    this.terminalManager = new TerminalManager(300000);
    this.clientHandler = new ClientMessageHandler({
      connectionManager: this.connectionManager,
      kv: this.kvStore,
      db: this.dbStore,
      jwtService,
      dployrdService,
      terminalManager: this.terminalManager,
    });
  }

  /**
   * Register a new WebSocket connection for a cluster.
   * @param connectionKey - The key to register under (instance tag for dedicated nodes, pool:tag for pool, clusterId for clients)
   * @param ws - The WebSocket connection
   * @param role - Whether this is a node or client
   * @param session - Optional session for clients
   * @param instanceTag - Instance tag (set for nodes)
   * @param clusterId - Actual cluster ID (set for nodes to find clients for notifications)
   */
  acceptWebSocket(connectionKey: string, ws: WebSocket, role: "node" | "client", session?: Session, instanceTag?: string, clusterId?: string): void {
    const conn = this.connectionManager.addConnection(connectionKey, ws, role, session, clusterId);

    if (role === "node" && instanceTag) {
      conn.instanceTag = instanceTag;
      this.kvStore.setNodeConnected(instanceTag).catch(() => {});
      worker.emit(NODES_HEALTH_JOB);
      worker.emit(NODES_SYNC_JOB);
    }

    // Handle reconnection for clients
    if (role === "client" && session) {
      const previousConnectionId = this.sessionConnections.get(session.userId);
      if (previousConnectionId) {
        this.clientNotifier.replayUnackedMessages(conn.connectionKey, conn.connectionId);
      }
      this.sessionConnections.set(session.userId, conn.connectionId);
    }

    ws.on("message", (data) => {
      this.handleMessage(conn, data).catch((err) => {
        this.log.error(`Error handling message for cluster ${clusterId}:`, err instanceof Error ? err : { error: String(err) });
      });
    });

    ws.on("close", () => {
      this.handleDisconnect(conn);
    });

    ws.on("error", (err) => {
      this.log.error(`Error on connection for cluster ${clusterId}:`, err);
      this.handleDisconnect(conn);
    });

    // Send hello message for nodes
    if (role === "node") {
      this.sendHello(ws);
    }
  }

  /**
   * Send hello message to node on connect
   */
  private sendHello(ws: WebSocket): void {
    try {
      ws.send(
        JSON.stringify({
          kind: "hello",
          status: "accepted",
          timestamp: Date.now(),
        }),
      );
    } catch (err) {
      this.log.error(`Failed to send hello:`, err);
    }
  }

  /**
   * Handle connection disconnect
   */
  private handleDisconnect(conn: ClusterConnection): void {
    this.connectionManager.removeConnection(conn);

    if (conn.role === "node") {
      if (conn.instanceTag) {
        this.kvStore.deleteNodeConnected(conn.instanceTag).catch(() => {});
      }
      this.dployrdHandler.handleNodeDisconnect(conn).catch((err) => {
        this.log.error(`Error deregistering node on disconnect:`, err);
      });
    }
  }

  /**
   * Forcibly terminate all node connections for a given instance tag.
   * Call this immediately after deleting an instance so stale routing entries are evicted.
   */
  evictNodeByTag(tag: string): void {
    const conns = this.connectionManager.getNodeConnections(tag);
    for (const conn of conns) {
      this.handleDisconnect(conn);
      try { conn.ws.terminate(); } catch {}
    }
    if (conns.length > 0) {
      this.log.info(`Evicted ${conns.length} WS connection(s) for deleted instance ${tag}`);
    }
  }

  /**
   * Route incoming messages to the appropriate handler
   */
  private async handleMessage(conn: ClusterConnection, data: unknown): Promise<void> {
    const message = parseMessage(data);
    if (!message) {
      this.log.error("Invalid message format");
      return;
    }

    if (conn.role === "node") {
      if (conn.instanceTag) {
        this.kvStore.refreshNodeConnected(conn.instanceTag).catch(() => {});
      }
      await this.dployrdHandler.handleMessage({ conn, message });
    } else {
      await this.clientHandler.handleMessage(conn, message);
    }
  }

  /**
   * Send a task using a pre-resolved routing key (clusterId or pool:tag).
   * Use this from HTTP routes where pool routing must be pre-computed.
   */
  public sendTask(routingKey: string, task: NodeTask): boolean {
    return this.connectionManager.sendTask(routingKey, task);
  }

  /**
   * Send a task to all nodes in a cluster.
   * Returns true if the task was sent to at least one node.
   */
  public sendTaskToCluster(clusterId: string, task: NodeTask): boolean {
    const nodeConns = this.connectionManager.getNodeConnections(clusterId);
    if (nodeConns.length === 0) {
      this.log.warn(`No node connections for cluster ${clusterId}`);
      return false;
    }

    const message = {
      kind: MESSAGE_KIND.TASK,
      items: [task],
    };

    const payload = JSON.stringify(message);
    let sentCount = 0;

    for (const nodeConn of nodeConns) {
      try {
        nodeConn.ws.send(payload);
        sentCount++;
      } catch (err) {
        this.log.error(`Failed to send task to node:`, err);
      }
    }

    this.log.info(`Sent task ${task.ID} to ${sentCount}/${nodeConns.length} nodes in cluster ${clusterId}`);
    return sentCount > 0;
  }

  /**
   * Check if any node is connected for the given cluster.
   */
  public hasNodeConnection(clusterId: string): boolean {
    return this.connectionManager.hasNodeConnection(clusterId);
  }

  /**
   * Get connection manager stats for monitoring/observability
   */
  public getStats(): ReturnType<ConnectionManager["getStats"]> {
    return this.connectionManager.getStats();
  }

  /**
   * Accept terminal relay connection from node
   */
  public acceptTerminalConnection(sessionId: string, ws: WebSocket): boolean {
    return this.terminalManager.acceptNodeConnection(sessionId, ws);
  }

  /**
   * Graceful shutdown
   */
  public shutdown(): void {
    this.connectionManager.stopCleanupLoop();
    this.terminalManager.destroy();
    this.log.info("WebSocket handler shutdown complete");
  }
}
