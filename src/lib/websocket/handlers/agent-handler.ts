// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { ConnectionManager } from "../connection-manager.js";
import type { ClusterConnection, BaseMessage, TaskResponseMessage, FileUpdateMessage } from "../message-types.js";
import { isAgentBroadcastMessage, isLogChunkMessage, isTaskResponseMessage, isFileUpdateMessage, MessageKind } from "../message-types.js";
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
    // Update activity timestamp
    this.connectionManager.updateActivity(conn.ws);

    // Handle task responses - route directly to requesting client
    if (isTaskResponseMessage(message)) {
      await this.handleTaskResponse(message);
      return;
    }

    // Handle status updates - broadcast to all clients
    if (isAgentBroadcastMessage(message)) {
      await this.clientNotifier.broadcast(conn.clusterId, message);
      return;
    }

    // Handle log chunks - route to specific subscription
    if (isLogChunkMessage(message)) {
      this.handleLogChunk(message);
      return;
    }

    // Handle file system updates - broadcast to subscribed clients
    if (isFileUpdateMessage(message)) {
      this.handleFileUpdate(conn.clusterId, message);
      return;
    }
  }

  /**
   * Handle task response messages from agent - route to specific client
   */
  private async handleTaskResponse(message: TaskResponseMessage): Promise<void> {
    const { taskId, success, data, error } = message;

    if (!taskId) {
      console.warn(`[WS] Received task_response without taskId`);
      return;
    }

    // Route response directly to the requesting client
    const routed = this.connectionManager.routeResponseToClient(taskId, {
      kind: this.getResponseKind(message),
      success,
      data,
      error,
    });

    if (!routed) {
      console.warn(`[WS] Could not route response for taskId: ${taskId} (request may have timed out)`);
    }
  }

  /**
   * Determine response kind based on the original request type
   */
  private getResponseKind(message: TaskResponseMessage): string {
    const request = this.connectionManager.getPendingRequest(message.taskId);
    if (request) {
      switch (request.kind) {
        case "file_read": return "file_read_response";
        case "file_write": return "file_write_response";
        case "file_create": return "file_create_response";
        case "file_delete": return "file_delete_response";
        case "file_tree": return "file_tree_response";
        case "deploy": return "deploy_response";
        default: return "task_response";
      }
    }
    return "task_response";
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

  /**
   * Handle filesystem update messages from agent
   */
  private handleFileUpdate(clusterId: string, message: FileUpdateMessage): void {
    const { instanceId, event } = message;
    const watchKey = `${instanceId}:${event.path}`;
    const subscribers = this.connectionManager.getFileWatchSubscribers(watchKey);

    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const payload = JSON.stringify(message);
    let sentCount = 0;

    const allConnections = this.connectionManager.getConnections(clusterId);
    if (!allConnections) return;

    for (const connectionId of subscribers) {
      const conn = Array.from(allConnections).find(c => c.connectionId === connectionId);
      if (conn && conn.ws.readyState === 1) {
        try {
          conn.ws.send(payload);
          sentCount++;
        } catch (err) {
          console.error(`[WS] Failed to send file update to connection ${connectionId}:`, err);
        }
      }
    }

    console.log(`[WS] Broadcast file update for ${watchKey} to ${sentCount}/${subscribers.size} subscribers`);
  }

  /**
   * Handle agent disconnection - fail pending requests
   */
  handleAgentDisconnect(clusterId: string): void {
    // This is handled by connection cleanup in ConnectionManager
    // Pending requests will timeout and send errors to clients
    console.log(`[WS] Agent disconnected from cluster ${clusterId}`);
  }
}
