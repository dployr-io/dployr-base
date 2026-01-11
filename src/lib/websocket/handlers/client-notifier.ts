// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { BaseMessage, UpdateMessage } from "@/lib/websocket/message-types.js";
import { MessageKind } from "@/lib/websocket/message-types.js";
import { ConnectionManager } from "@/lib/websocket/connection-manager.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { ulid } from "ulid";

/**
 * Handles broadcasting messages to connected clients.
 * 
 * NOTE: This is now ONLY used for status broadcasts.
 * File operation responses are routed directly via ConnectionManager.
 */
export class ClientNotifier {
  constructor(
    private conn: ConnectionManager,
    private kv: KVStore,
  ) {}

  /**
   * Broadcast status updates to all client connections in a cluster. 
   */
  async broadcast(clusterId: string, message: UpdateMessage): Promise<void> {
    const clients = this.conn.getClientConnections(clusterId);
    if (clients.length === 0) return;

    const messageId = ulid();
    const payload = JSON.stringify({
      ...message,
      messageId,
    });

    // Store for potential retry on reconnect
    this.conn.storeUnackedMessage(`${clusterId}:${messageId}`, message);

    for (const client of clients) {
      try {
        client.ws.send(payload);
      } catch (err) {
        console.error(`[WS] Failed to send to client:`, err);
      }
    }

    await this.cacheStatusIfNeeded(clusterId, message, payload);
  }

  /**
   * Send a message to a specific client (non-broadcast message)
   */
  async sendToClient(clusterId: string, connectionId: string, message: BaseMessage): Promise<boolean> {
    const clients = this.conn.getClientConnections(clusterId);
    const target = clients.find(c => c.connectionId === connectionId);
    
    if (!target) {
      console.warn(`[WS] Client ${connectionId} not found in cluster ${clusterId}`);
      return false;
    }

    try {
      target.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error(`[WS] Failed to send to client ${connectionId}:`, err);
      return false;
    }
  }

  /**
   * Replay unacked messages to a reconnected client
   */
  async replayUnackedMessages(clusterId: string, connectionId: string): Promise<number> {
    const messages = this.conn.getUnackedMessages();
    let replayed = 0;

    if (messages.length > 0) {
      const { messageId, message } = messages[messages.length - 1];
      if (messageId.startsWith(`${clusterId}:`)) {
        const sent = await this.sendToClient(clusterId, connectionId, message as BaseMessage);
        if (sent) replayed++;
      }
    }

    console.log(`[WS] Replayed ${replayed} unacked messages to client ${connectionId}`);
    return replayed;
  }

  private async cacheStatusIfNeeded(clusterId: string, message: BaseMessage, payload: string): Promise<void> {
    if (message.kind === MessageKind.UPDATE) {
      try {
        await this.kv.kv.put(`cluster:${clusterId}:status`, payload, { ttl: 300 });
      } catch (err) {
        console.error(`[WS] Failed to cache status:`, err);
      }
    }
  }
}
