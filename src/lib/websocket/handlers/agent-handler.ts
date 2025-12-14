// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { ConnectionManager } from "../connection-manager.js";
import type { ClusterConnection, BaseMessage } from "../message-types.js";
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
   * Process a message from an agent
   */
  async handleMessage(conn: ClusterConnection, message: BaseMessage): Promise<void> {
    if (isAgentBroadcastMessage(message)) {
      await this.clientNotifier.broadcast(conn.clusterId, message);
      return;
    }

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
