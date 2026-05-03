// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import type { ConnectionManager } from "../connection-manager.js";
import type { ClusterConnection, BaseMessage, TaskResponseMessage, FileUpdateMessage } from "../../../types/websocket-message.js";
import { isNodeBroadcastMessage, isLogChunkMessage, isTaskResponseMessage, isFileUpdateMessage, createWSError } from "../../../types/websocket-message.js";
import { ClientNotifier } from "./client-notifier.js";
import { UpdateProcessor } from "@/lib/node/update-processor.js";
import { NodeUpdate } from "@/types/node.js";
import { MESSAGE_KIND, WSErrorCode } from "@/lib/constants/websocket.js";
import type { JWTService } from "@/services/auth/jwt.js";
import type { DployrdService } from "@/services/dployrd.js";

/**
 * Handles messages from dployrd connections.
 */
export class NodeMessageHandler {
  constructor(
    private connectionManager: ConnectionManager,
    private clientNotifier: ClientNotifier,
    private db: DatabaseStore,
    private kv: KVStore,
    private jwtService?: JWTService,
    private dployrdService?: DployrdService,
  ) {}

  /**
   * Process a message from an node
   */
  async handleMessage({ conn, message }: { conn: ClusterConnection; message: BaseMessage }): Promise<void> {
    this.connectionManager.updateActivity(conn.ws);

    if (isTaskResponseMessage(message)) {
      await this.handleTaskResponse({ conn, message });
      return;
    }

    if (isNodeBroadcastMessage(message)) {
      const update = (message as any).update as NodeUpdate;
      let changedFlags = { servicesChanged: false, deploymentsChanged: false };

      if (update?.instance_id) {
        changedFlags = await new UpdateProcessor({
          db: this.db,
          kv: this.kv,
          tag: update.instance_id,
          message: update,
          connectionManager: this.connectionManager,
          jwtService: this.jwtService,
          dployrdService: this.dployrdService,
        }).processUpdate();
      }

      if (conn.connectionKey.startsWith("pool:")) {
        const instanceTag = conn.connectionKey.slice("pool:".length);
        const { clusters } = await this.db.clusters.list({ instanceTag: instanceTag });
        await Promise.all(
          clusters.map(async (cluster) => {
            await this.clientNotifier.broadcast(cluster.id, message);
            if (changedFlags.servicesChanged) this.clientNotifier.notifyRefresh(cluster.id, "services");
            if (changedFlags.deploymentsChanged) this.clientNotifier.notifyRefresh(cluster.id, "deployments");
          }),
        );
      } else if (conn.clusterId) {
        await this.clientNotifier.broadcast(conn.clusterId, message);
        if (changedFlags.servicesChanged) this.clientNotifier.notifyRefresh(conn.clusterId, "services");
        if (changedFlags.deploymentsChanged) this.clientNotifier.notifyRefresh(conn.clusterId, "deployments");
      }
      return;
    }

    if (isLogChunkMessage(message)) {
      this.handleLogChunk(message);
      return;
    }

    if (isFileUpdateMessage(message)) {
      this.handleFileUpdate(message);
      return;
    }
  }

  /**
   * Handle task response messages from node - route to specific client
   */
  private async handleTaskResponse({ conn, message }: { conn: ClusterConnection; message: TaskResponseMessage }): Promise<void> {
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

        const errorResponse = createWSError(request.requestId, errorCode, errorMessage);

        request.ws.send(JSON.stringify(errorResponse));
        this.connectionManager.removePendingRequest(taskId);
        console.warn(`[WS] Task ${taskId} failed: ${errorMessage}`);
        return;
      }
    }

    const responseKind = this.getResponseKind(message);

    // Route response directly to the requesting client
    const routed = this.connectionManager.routeResponseToClient(taskId, { kind: responseKind, success, data, error });
  }

  /**
   * Determine response kind based on the original request type
   */
  private getResponseKind(message: TaskResponseMessage): string {
    const request = this.connectionManager.getPendingRequest(message.taskId);
    if (request) {
      switch (request.kind) {
        case MESSAGE_KIND.FILE_READ:
          return "file_read_response";
        case MESSAGE_KIND.FILE_WRITE:
          return "file_write_response";
        case MESSAGE_KIND.FILE_CREATE:
          return "file_create_response";
        case MESSAGE_KIND.FILE_DELETE:
          return "file_delete_response";
        case MESSAGE_KIND.FILE_TREE:
          return "file_tree_response";
        case MESSAGE_KIND.DEPLOY:
          return "deploy_response";
        case MESSAGE_KIND.SERVICE_REMOVE:
          return "service_remove_response";
        case MESSAGE_KIND.PROXY_STATUS:
          return "proxy_status_response";
        case MESSAGE_KIND.PROXY_RESTART:
          return "proxy_restart_response";
        case MESSAGE_KIND.PROXY_ADD:
          return "proxy_add_response";
        case MESSAGE_KIND.PROXY_REMOVE:
          return "proxy_remove_response";
        default:
          return "task_response";
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
   * Handle filesystem update messages from node
   */
  private handleFileUpdate(message: FileUpdateMessage): void {
    const { instanceId, event } = message;
    const watchKey = `${instanceId}:${event.path}`;
    const subscribers = this.connectionManager.getFileWatchSubscribers(watchKey);

    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const payload = JSON.stringify(message);
    let sentCount = 0;

    for (const connectionId of subscribers) {
      const conn = this.connectionManager.getConnectionById(connectionId);
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
   * Handle node disconnection - fail pending requests
   */
  handleNodeDisconnect(connectionKey: string): void {
    console.log("[WS] Node disconnected from base: ", connectionKey);
  }
}
