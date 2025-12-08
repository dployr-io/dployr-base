// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { DployrdTask } from "@/lib/tasks/types.js";
import { DployrdService } from "@/services/dployrd-service.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { JWTService } from "@/services/jwt.js";

interface InstanceConnection {
  ws: WebSocket;
  role: "agent" | "client";
  instanceId: string;
}

interface LogStreamSubscription {
  streamId: string;
  path: string;
  clientWs: WebSocket;
  startOffset?: number;
  limit?: number;
}

/**
 * Simple in-memory WebSocket handler for instance streams.
 * Replaces the old Durable Object adapter with a Node-native implementation.
 */
export class WebSocketHandler {
  private connections = new Map<string, Set<InstanceConnection>>();
  // Track active log stream subscriptions: streamId -> subscription details
  private logStreams = new Map<string, LogStreamSubscription>();
  private dployrd = new DployrdService();

  constructor(private kv: IKVAdapter) {}

  /**
   * Register a new WebSocket connection for an instance.
   */
  acceptWebSocket(
    instanceId: string,
    ws: WebSocket,
    role: "agent" | "client"
  ): void {
    if (!this.connections.has(instanceId)) {
      this.connections.set(instanceId, new Set());
    }

    const conn: InstanceConnection = { ws, role, instanceId };
    this.connections.get(instanceId)!.add(conn);

    ws.on("message", (data) => {
      this.handleMessage(conn, data).catch((err) => {
        console.error(
          `[WS] Error handling message for instance ${instanceId}:`,
          err
        );
      });
    });

    ws.on("close", () => {
      this.removeConnection(conn);
    });

    ws.on("error", (err) => {
      console.error(
        `[WS] Error on connection for instance ${instanceId}:`,
        err
      );
      this.removeConnection(conn);
    });

    console.log(`[WS] ${role} connected to instance ${instanceId}`);
  }

  private async handleMessage(
    conn: InstanceConnection,
    data: any
  ): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }

    const kind = payload?.kind;
    if (!kind) {
      console.error("[WS] Invalid message format for instance", payload);
      return;
    }

    // Agent sends updates/status/logs
    if (conn.role === "agent") {
      if (
        kind === "update" ||
        kind === "status_report"
      ) {
        // Broadcast to all clients subscribed to this instance
        this.broadcastToClients(conn.instanceId, payload);
      }

      // Handle log chunks - route to specific stream subscriber
      if (kind === "log_chunk") {
        const streamId = payload?.streamId as string | undefined;
        if (streamId) {
          const subscription = this.logStreams.get(streamId);
          if (subscription) {
            try {
              subscription.clientWs.send(JSON.stringify(payload));
            } catch (err) {
              console.error(`[WS] Failed to send log chunk to client:`, err);
              // Clean up dead subscription
              this.logStreams.delete(streamId);
            }
          }
        } else {
          console.warn(`[WS] Received log_chunk without streamId`);
        }
      }
    }

    // Client subscribes to updates
    if (conn.role === "client") {
      if (kind === "client_subscribe") {
        const cached = await this.kv.get(`instance:${conn.instanceId}:status`);
        if (cached) {
          try {
            conn.ws.send(cached);
          } catch (err) {
            console.error(`[WS] Failed to send cached status:`, err);
          }
        }
      }

      if (kind === "log_subscribe") {
        const path = payload?.path as string | undefined;
        const startOffset = payload?.startOffset as number | undefined;
        const limit = payload?.limit as number | undefined;

        if (!path) {
          console.error("[WS] log_subscribe missing path");
          return;
        }

        const offsetKey = startOffset ?? 0;
        const limitKey = limit ?? -1;
        const streamId = `${conn.instanceId}:${path}:${offsetKey}:${limitKey}`;

        const existing = this.logStreams.get(streamId);
        if (existing) {
          // Reuse existing daemon log stream; just attach this client
          existing.clientWs = conn.ws;
          this.logStreams.set(streamId, existing);
          console.log(`[WS] Reusing existing log stream ${streamId} for instance ${conn.instanceId}`);
          return;
        }

        this.logStreams.set(streamId, {
          streamId,
          path,
          clientWs: conn.ws,
          startOffset,
          limit,
        });

        const kvStore = new KVStore(this.kv);
        const jwtService = new JWTService(kvStore);
        const token = await jwtService.createAgentAccessToken(conn.instanceId);

        const task = this.dployrd.createLogStreamTask(streamId, path, startOffset, limit, token);

        this.sendTaskToAgent(conn.instanceId, task);

        console.log(`[WS] Created log stream task ${streamId} for instance ${conn.instanceId}`);
      }

      if (kind === "log_unsubscribe") {
        const path = payload?.path as string | undefined;
        if (path) {
          // Remove all streams for this instance/path belonging to this client
          for (const [streamId, subscription] of this.logStreams.entries()) {
            if (subscription.path === path && subscription.clientWs === conn.ws) {
              this.logStreams.delete(streamId);
              console.log(`[WS] Removed log stream ${streamId}`);
            }
          }
        }
      }
    }
  }

  private broadcastToClients(instanceId: string, message: any): void {
    const conns = this.connections.get(instanceId);
    if (!conns) return;

    const payload = JSON.stringify(message);
    for (const conn of conns) {
      if (conn.role === "client") {
        try {
          conn.ws.send(payload);
        } catch (err) {
          console.error(`[WS] Failed to send to client:`, err);
        }
      }
    }

    // Cache latest status for new subscribers
    if (message.kind === "status_report" || message.kind === "update") {
      this.kv
        .put(`instance:${instanceId}:status`, payload, { expirationTtl: 300 })
        .catch((err) => console.error(`[WS] Failed to cache status:`, err));
    }
  }

  /**
   * Send a task to the agent for this instance.
   * Returns true if the task was sent, false if no agent is connected.
   */
  public sendTaskToAgent(instanceId: string, task: DployrdTask): boolean {
    const conns = this.connections.get(instanceId);
    if (!conns) {
      console.warn(`[WS] No connections for instance ${instanceId}`);
      return false;
    }

    const agentConn = Array.from(conns).find(c => c.role === "agent");
    if (!agentConn) {
      console.warn(`[WS] No agent connection for instance ${instanceId}`);
      return false;
    }

    const message = {
      kind: "task",
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
    const conns = this.connections.get(instanceId);
    if (!conns) return false;
    return Array.from(conns).some(c => c.role === "agent");
  }

  private removeConnection(conn: InstanceConnection): void {
    const conns = this.connections.get(conn.instanceId);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) {
        this.connections.delete(conn.instanceId);
      }
    }

    // Clean up log streams for this client
    if (conn.role === "client") {
      for (const [streamId, subscription] of this.logStreams.entries()) {
        if (subscription.clientWs === conn.ws) {
          this.logStreams.delete(streamId);
          console.log(`[WS] Cleaned up log stream ${streamId}`);
        }
      }
    }

    console.log(
      `[WS] ${conn.role} disconnected from instance ${conn.instanceId}`
    );
  }
}
