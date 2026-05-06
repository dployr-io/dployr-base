// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DeploymentPayload } from "@/lib/tasks/types.js";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { PAYLOAD_TTL } from "@/lib/constants/index.js";

export interface PendingDeploymentPayload {
  clusterId: string;
  instanceName: string;
  taskId: string;
  payload: DeploymentPayload;
  createdAt: number;
}

/**
 * Stores deployment request payloads until a node reports the canonical
 * deployment ID. This keeps the database row keyed by the daemon-created ID
 * while preserving request metadata, env vars, and secrets for sync.
 */
export class PayloadStore {
  constructor(private kv: IKVAdapter) {}

  /**
   * Stores a deployment request payload in the pending payload lobby.
   *
   * The payload is keyed by cluster and deployment name because the canonical
   * deployment ID is created by the connected node later. Callers use this to
   * preserve request-only metadata, env vars, and secrets until `/finish` or a
   * node update reports the deployment with its final ID.
   *
   * @param clusterId - Cluster that owns the deployment request.
   * @param instanceName - Target instance tag used for dispatch.
   * @param taskId - Task ID sent to the node.
   * @param payload - Validated deployment payload from the API request.
   * @returns The stored pending payload envelope, including `createdAt`.
   */
  async saveDeploymentPayload({
    clusterId,
    instanceName,
    taskId,
    payload,
  }: {
    clusterId: string;
    instanceName: string;
    taskId: string;
    payload: DeploymentPayload;
  }): Promise<PendingDeploymentPayload> {
    const pending: PendingDeploymentPayload = {
      clusterId,
      instanceName,
      taskId,
      payload,
      createdAt: Date.now(),
    };

    await this.kv.put(KV_KEYS.PAYLOAD.DEPLOYMENT(clusterId, payload.name), JSON.stringify(pending), { ttl: PAYLOAD_TTL });
    return pending;
  }

  /**
   * Retrieves a pending deployment payload by cluster and deployment name.
   *
   * Returns `null` when no payload exists or when the stored value cannot be
   * parsed. The pending entry may also disappear naturally when its TTL expires.
   *
   * @param clusterId - Cluster that owns the deployment request.
   * @param name - Deployment/service name used as the lobby lookup key.
   * @returns The pending payload envelope, or `null` if unavailable.
   */
  private async getDeploymentPayload({ clusterId, name }: { clusterId: string; name: string }): Promise<PendingDeploymentPayload | null> {
    const data = await this.kv.get(KV_KEYS.PAYLOAD.DEPLOYMENT(clusterId, name));
    if (!data) return null;

    try {
      return JSON.parse(data) as PendingDeploymentPayload;
    } catch {
      return null;
    }
  }

  /**
   * Reads and removes a pending deployment payload in one convenience call.
   *
   * @param clusterId - Cluster that owns the deployment request.
   * @param name - Deployment/service name used as the lobby lookup key.
   * @returns The pending payload envelope, or `null` if unavailable.
   */
  async consumeDeploymentPayload({ clusterId, name }: { clusterId: string; name: string }): Promise<PendingDeploymentPayload | null> {
    const pending = await this.getDeploymentPayload({ clusterId, name });
    await this.deleteDeploymentPayload({ clusterId, name });
    return pending;
  }

  /**
   * Deletes a pending deployment payload from the lobby.
   *
   * @param clusterId - Cluster that owns the deployment request.
   * @param name - Deployment/service name used as the lobby lookup key.
   */
  private async deleteDeploymentPayload({ clusterId, name }: { clusterId: string; name: string }): Promise<void> {
    await this.kv.delete(KV_KEYS.PAYLOAD.DEPLOYMENT(clusterId, name));
  }

  /**
   * Lists all pending deployment payloads for a cluster, newest first.
   *
   * @param clusterId - Cluster whose pending deployment payloads should be listed.
   * @returns Pending payload envelopes sorted by `createdAt` descending.
   */
  async listDeploymentPayloads(clusterId: string): Promise<PendingDeploymentPayload[]> {
    const prefix = KV_KEYS.PAYLOAD.DEPLOYMENTS_PREFIX(clusterId);
    const result = await this.kv.list({ prefix });
    const payloads = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        try {
          return JSON.parse(data) as PendingDeploymentPayload;
        } catch {
          return null;
        }
      }),
    );

    return payloads.filter((payload): payload is PendingDeploymentPayload => payload !== null).sort((a, b) => b.createdAt - a.createdAt);
  }
}
