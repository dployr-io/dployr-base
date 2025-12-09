// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { ConnectionManager } from "../connection-manager.js";
import type { InstanceConnection, BaseMessage } from "../message-types.js";
import { isAgentBroadcastMessage, isLogChunkMessage } from "../message-types.js";

/**
 * Handles messages from dployrd connections.
 */
export class AgentMessageHandler {
  constructor(
    private connectionManager: ConnectionManager,
    private kv: IKVAdapter
  ) {}

  /**
   * Process a message from an dployrd
   */
  async handleMessage(conn: InstanceConnection, message: BaseMessage): Promise<void> {
    // Broadcast update/status messages to all clients
    if (isAgentBroadcastMessage(message)) {
      await this.broadcastToClients(conn.instanceId, message);
      return;
    }

    // Route log chunks to specific stream subscriber
    if (isLogChunkMessage(message)) {
      this.handleLogChunk(message);
      return;
    }
  }

  /**
   * Broadcast a message to all clients subscribed to an instance
   */
  private async broadcastToClients(instanceId: string, message: BaseMessage): Promise<void> {
    const clients = this.connectionManager.getClientConnections(instanceId);
    if (clients.length === 0) return;

    const payload = JSON.stringify(message);

    for (const client of clients) {
      try {
        client.ws.send(payload);
      } catch (err) {
        console.error(`[WS] Failed to send to client:`, err);
      }
    }

    // Cache latest status for new subscribers
    await this.cacheStatus(instanceId, message, payload);
  }

  /**
   * Cache status updates for new subscribers
   */
  private async cacheStatus(instanceId: string, message: BaseMessage, payload: string): Promise<void> {
    if (message.kind === "status_report" || message.kind === "update") {
      try {
        await this.kv.put(`instance:${instanceId}:status`, payload, { expirationTtl: 300 });
      } catch (err) {
        console.error(`[WS] Failed to cache status:`, err);
      }
    }
  }

  /**
   * Handle log chunk messages from dployrd
   */
  private handleLogChunk(message: { streamId?: string; [key: string]: unknown }): void {
    const streamId = message.streamId;
    if (!streamId) {
      console.warn(`[WS] Received log_chunk without streamId`);
      return;
    }

    const subscription = this.connectionManager.getLogStream(streamId);
    if (!subscription) {
      return;
    }

    try {
      subscription.ws.send(JSON.stringify(message));
    } catch (err) {
      console.error(`[WS] Failed to send log chunk to client:`, err);
      // Clean up dead subscription
      this.connectionManager.removeLogStream(streamId);
    }
  }
}
