// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { ConnectionManager } from "../connection-manager.js";
import type { InstanceConnection, BaseMessage } from "../message-types.js";
import { isAgentBroadcastMessage, isLogChunkMessage } from "../message-types.js";
import { ClientNotifier } from "./client-notifier.js";

/**
 * Handles messages from dployrd connections.
 */
export class AgentMessageHandler {
  constructor(
    private connectionManager: ConnectionManager,
    private clientNotifier: ClientNotifier,
  ) {}

  /**
   * Process a message from an dployrd
   */
  async handleMessage(conn: InstanceConnection, message: BaseMessage): Promise<void> {
    // Broadcast update/status messages to all clients
    if (isAgentBroadcastMessage(message)) {
      await this.clientNotifier.broadcast(conn.instanceId, message);
      return;
    }

    // Route log chunks to specific stream subscriber
    if (isLogChunkMessage(message)) {
      this.handleLogChunk(message);
      return;
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
