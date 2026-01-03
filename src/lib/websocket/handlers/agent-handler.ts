// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import type { ConnectionManager } from "../connection-manager.js";
import type { ClusterConnection, BaseMessage, TaskResponseMessage, FileUpdateMessage } from "../message-types.js";
import { isAgentBroadcastMessage, isLogChunkMessage, isTaskResponseMessage, isFileUpdateMessage, MessageKind, WSErrorCode, createWSError } from "../message-types.js";
import { ClientNotifier } from "./client-notifier.js";
import { UpdateProcessor } from "@/lib/agent/update-processor.js";
import { AgentUpdateV1 } from "@/types/agent.js";

/**
 * Handles messages from dployrd connections.
 */
export class AgentMessageHandler {
  private updateProcessor: UpdateProcessor;

  constructor(
    private connectionManager: ConnectionManager,
    private clientNotifier: ClientNotifier,
    private db: DatabaseStore,
    private kv: KVStore,
  ) {
    this.updateProcessor = new UpdateProcessor(db, kv);
  }

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
      const update = (message as any).update as AgentUpdateV1;
      
      if (update?.instance_id) {
        await this.updateProcessor.processUpdate(update.instance_id, update);
      }

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

    // If task failed, send error to client
    if (!success && error) {
      const request = this.connectionManager.getPendingRequest(taskId);
      if (request) {
        let errorCode = error.code || WSErrorCode.INTERNAL_ERROR;
        let errorMessage = error.message || "Task failed";
        
        if (errorMessage.includes('{"error":')) {
          try {
            const jsonMatch = errorMessage.match(/\{.*?\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.code) {
                switch (parsed.code) {
                  case "auth.unauthorized":
                    errorCode = WSErrorCode.UNAUTHORIZED;
                    errorMessage = "Authentication failed. Please check your credentials and try again.";
                    break;
                  case "auth.forbidden":
                    errorCode = WSErrorCode.PERMISSION_DENIED;
                    errorMessage = "You don't have permission to perform this action.";
                    break;
                  case "resource.not_found":
                    errorCode = WSErrorCode.NOT_FOUND;
                    errorMessage = "The requested resource was not found.";
                    break;
                  case "request.missing_params":
                    errorCode = WSErrorCode.MISSING_FIELD;
                    errorMessage = "Missing required parameters.";
                    break;
                  case "request.bad_request":
                    errorCode = WSErrorCode.MISSING_FIELD;
                    errorMessage = "Invalid request. Please check your input and try again.";
                    break;
                  case "runtime.internal_server_error":
                  case "instance.registration_failed":
                    errorCode = WSErrorCode.INTERNAL_ERROR;
                    errorMessage = "An internal error occurred. Please try again later.";
                    break;
                  default:
                    errorCode = WSErrorCode.INTERNAL_ERROR;
                    errorMessage = parsed.error || "An error occurred. Please try again.";
                }
              }
            }
          } catch (e) {
            // Keep original error if parsing fails
          }
        }
        
        const errorResponse = createWSError(
          request.requestId,
          errorCode,
          errorMessage
        );
        
        request.ws.send(JSON.stringify(errorResponse));
        this.connectionManager.removePendingRequest(taskId);
        console.warn(`[WS] Task ${taskId} failed: ${errorMessage}`);
        return;
      }
    }

    // Route response directly to the requesting client
    const routed = this.connectionManager.routeResponseToClient(taskId, {
      kind: this.getResponseKind(message),
      success,
      data,
      error,
    });

    if (success && data && this.getResponseKind(message) === "deploy_response") {
      this.db.services.save(data['instance_id'], data['name']);
    }

    if (success && data && this.getResponseKind(message) === "service_remove_response") {
      this.db.services.deleteByName(data['name']);
    }

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
        case MessageKind.FILE_READ: return "file_read_response";
        case MessageKind.FILE_WRITE: return "file_write_response";
        case MessageKind.FILE_CREATE: return "file_create_response";
        case MessageKind.FILE_DELETE: return "file_delete_response";
        case MessageKind.FILE_TREE: return "file_tree_response";
        case MessageKind.DEPLOY: return "deploy_response";
        case MessageKind.SERVICE_REMOVE: return "service_remove_response";
        case MessageKind.PROXY_STATUS: return "proxy_status_response";
        case MessageKind.PROXY_RESTART: return "proxy_restart_response";
        case MessageKind.PROXY_ADD: return "proxy_add_response";
        case MessageKind.PROXY_REMOVE: return "proxy_remove_response";
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
