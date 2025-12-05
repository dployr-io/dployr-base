// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";

interface InstanceConnection {
  ws: WebSocket;
  role: "agent" | "client";
  instanceId: string;
}

/**
 * Simple in-memory WebSocket handler for instance streams.
 * Replaces the old Durable Object adapter with a Node-native implementation.
 */
export class WebSocketHandler {
  private connections = new Map<string, Set<InstanceConnection>>();

  constructor(private kv: IKVAdapter) {}

  /**
   * Register a new WebSocket connection for an instance.
   */
  acceptWebSocket(instanceId: string, ws: WebSocket, role: "agent" | "client"): void {
    if (!this.connections.has(instanceId)) {
      this.connections.set(instanceId, new Set());
    }

    const conn: InstanceConnection = { ws, role, instanceId };
    this.connections.get(instanceId)!.add(conn);

    ws.on("message", (data) => {
      this.handleMessage(conn, data).catch((err) => {
        console.error(`[WS] Error handling message for instance ${instanceId}:`, err);
      });
    });

    ws.on("close", () => {
      this.removeConnection(conn);
    });

    ws.on("error", (err) => {
      console.error(`[WS] Error on connection for instance ${instanceId}:`, err);
      this.removeConnection(conn);
    });

    console.log(`[WS] ${role} connected to instance ${instanceId}`);
  }

  private async handleMessage(conn: InstanceConnection, data: any): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }

    const kind = payload?.kind;
    if (!kind) return;

    // Agent sends updates/status/logs
    if (conn.role === "agent") {
      if (kind === "update" || kind === "status_report" || kind === "log_chunk") {
        // Broadcast to all clients subscribed to this instance
        this.broadcastToClients(conn.instanceId, payload);
      }
    }

    // Client subscribes to updates
    if (conn.role === "client" && kind === "client_subscribe") {
      // Send latest cached status if available
      const cached = await this.kv.get(`instance:${conn.instanceId}:status`);
      if (cached) {
        try {
          conn.ws.send(cached);
        } catch (err) {
          console.error(`[WS] Failed to send cached status:`, err);
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

  private removeConnection(conn: InstanceConnection): void {
    const conns = this.connections.get(conn.instanceId);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) {
        this.connections.delete(conn.instanceId);
      }
    }
    console.log(`[WS] ${conn.role} disconnected from instance ${conn.instanceId}`);
  }
}
