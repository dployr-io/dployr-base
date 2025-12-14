// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { BaseMessage } from "@/lib/websocket/message-types.js";
import { MessageKind } from "@/lib/websocket/message-types.js";
import { ConnectionManager } from "@/lib/websocket/connection-manager.js";

/**
 * Handles broadcasting messages to connected clients and caching status data.
 */
export class ClientNotifier {
  constructor(
    private conn: ConnectionManager,
    private kv: IKVAdapter,
  ) {}

  /**
   * Broadcast agent updates to all client connections 
   */
  async broadcast(clusterId: string, message: BaseMessage): Promise<void> {
    const clients = this.conn.getClientConnections(clusterId);
    if (clients.length === 0) return;

    const payload = JSON.stringify(message);

    for (const client of clients) {
      try {
        client.ws.send(payload);
      } catch (err) {
        console.error(`[WS] Failed to send to client:`, err);
      }
    }

    await this.cacheStatusIfNeeded(clusterId, message, payload);
  }

  private async cacheStatusIfNeeded(clusterId: string, message: BaseMessage, payload: string): Promise<void> {
    if (message.kind === MessageKind.UPDATE) {
      try {
        await this.kv.put(`cluster:${clusterId}:status`, payload, { ttl: 300 });
      } catch (err) {
        console.error(`[WS] Failed to cache status:`, err);
      }
    }
  }
}
