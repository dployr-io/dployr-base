// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { BaseMessage } from "@/types/websocket-message.js";
import { ConnectionManager } from "@/services/websocket/connection-manager.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { MESSAGE_KIND } from "@/lib/constants/websocket.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import type { NodeStateEntity } from "@/lib/constants/node-state.js";
import { Logger } from "@/lib/logger.js";

/**
 * Handles broadcasting messages to connected clients.
 *
 * NOTE: This is now ONLY used for status broadcasts.
 * File operation responses are routed directly via ConnectionManager.
 */
export class ClientNotifier {
  private log = new Logger("ws-notifier");

  constructor(
    private conn: ConnectionManager,
    private kv: KVStore,
  ) {}

  /**
   * Emit a lightweight revalidation signal to all clients in a cluster.
   * Clients invalidate the relevant http client query cache (e.g Tanstack) and refetch via HTTP.
   */
  notifyRefresh(clusterId: string, entity: "services" | "deployments"): void {
    const clients = this.conn.getClientConnections(clusterId);
    if (clients.length === 0) return;

    const payload = JSON.stringify({ kind: "refresh", entity, clusterId });
    for (const client of clients) {
      try {
        client.ws.send(payload);
      } catch (err) {
        this.log.error("Failed to send refresh signal to client", { error: String(err) });
      }
    }
  }

  /**
   * Broadcast delta updates to all client connections in a cluster.
   * Only sends sections that have changed since the client last saw them.
   *
   * Workloads are read from the cluster-scoped KV key written by node-handler,
   * which already contains only the services belonging to this cluster.
   * All other sections are read from the raw instance key as normal.
   */
  async broadcast(
    clusterId: string,
    instanceId: string,
    sections: NodeStateEntity[],
  ): Promise<void> {
    const clients = this.conn.getClientConnections(clusterId);
    if (!clients.length) return;

    for (const client of clients) {
      const changed: Record<string, { data: unknown; version: number }> = {};

      for (const section of sections) {
        const key = section === "workloads"
          ? KV_KEYS.CLUSTER.WORKLOADS(clusterId, instanceId)
          : KV_KEYS.INSTANCE.ENTITY(instanceId, section);

        const entity = await this.kv.entities.getEntity(key);
        if (!entity) continue;

        // Don't broadcast empty workloads — the heartbeat path covers that via DB fallback.
        if (section === "workloads") {
          const d = entity.data as any;
          const hasServices = Array.isArray(d?.services) && d.services.length > 0;
          const hasDeployments = Array.isArray(d?.deployments) && d.deployments.length > 0;
          if (!hasServices && !hasDeployments) continue;
        }

        const clientVersion = this.conn.getClientVersion(client.connectionId, instanceId, section);
        if (entity.version > clientVersion) {
          changed[section] = { data: entity.data, version: entity.version };
        }
      }

      if (!Object.keys(changed).length) continue;

      try {
        client.ws.send(JSON.stringify({ kind: MESSAGE_KIND.DELTA_UPDATE, instanceId, sections: changed }));

        for (const [section, { version }] of Object.entries(changed)) {
          this.conn.setClientVersion(client.connectionId, instanceId, section as NodeStateEntity, version);
        }
      } catch (err) {
        this.log.error(`Failed to send delta to client ${client.connectionId}`, { error: String(err) });
      }
    }
  }

  /**
   * Send a message to a specific client (non-broadcast message)
   */
  async sendToClient(clusterId: string, connectionId: string, message: BaseMessage): Promise<boolean> {
    const clients = this.conn.getClientConnections(clusterId);
    const target = clients.find((c) => c.connectionId === connectionId);

    if (!target) {
      this.log.warn(`Client ${connectionId} not found in cluster ${clusterId}`);
      return false;
    }

    try {
      target.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.log.error(`Failed to send to client ${connectionId}`, { error: String(err) });
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

    this.log.info(`Replayed ${replayed} unacked messages to client ${connectionId}`);
    return replayed;
  }
}
