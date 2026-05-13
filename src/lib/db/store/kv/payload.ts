// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DeploymentPayload } from "@/lib/tasks/types.js";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { PAYLOAD_TTL } from "@/lib/constants/index.js";
import type { SubscriptionPlan } from "@/types/index.js";

export interface BuildCallback {
  callbackInstanceTag: string;
  buildNodeTag: string;
  clusterId: string;
  payload: DeploymentPayload;
  fingerprint: string;
}

/** A build task waiting in the durable queue. */
export interface BuildQueueEntry {
  taskId: string;
  clusterId: string;
  callbackInstanceTag: string;
  payload: DeploymentPayload;
  fingerprint: string;
  /** Tier of the cluster — determines dispatch priority. */
  tier: SubscriptionPlan;
  /** Unix ms when enqueued — used as tiebreaker within the same priority. */
  enqueuedAt: number;
}

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

  async saveBuildCallback(taskId: string, callback: BuildCallback): Promise<void> {
    await this.kv.put(KV_KEYS.BUILD.CALLBACK(taskId), JSON.stringify(callback), { ttl: PAYLOAD_TTL });
  }

  async consumeBuildCallback(taskId: string): Promise<BuildCallback | null> {
    const data = await this.kv.get(KV_KEYS.BUILD.CALLBACK(taskId));
    await this.kv.delete(KV_KEYS.BUILD.CALLBACK(taskId));
    if (!data) return null;
    try {
      return JSON.parse(data) as BuildCallback;
    } catch {
      return null;
    }
  }

  /**
   * Enqueues a build task. The entry is persisted individually under
   * `KV_KEYS.BUILD.QUEUE_ITEM(taskId)` and its taskId is appended to the
   * queue index at `KV_KEYS.BUILD.QUEUE`.
   */
  async enqueueBuild(entry: BuildQueueEntry): Promise<void> {
    await this.kv.put(KV_KEYS.BUILD.QUEUE_ITEM(entry.taskId), JSON.stringify(entry), { ttl: PAYLOAD_TTL });

    const raw = await this.kv.get(KV_KEYS.BUILD.QUEUE);
    const index: string[] = raw ? JSON.parse(raw) : [];
    if (!index.includes(entry.taskId)) {
      index.push(entry.taskId);
    }
    await this.kv.put(KV_KEYS.BUILD.QUEUE, JSON.stringify(index), { ttl: PAYLOAD_TTL });
  }

  /**
   * Returns all queued build entries sorted by dispatch priority:
   * tier weight descending, then enqueuedAt ascending (FIFO within tier).
   */
  async listBuildQueue(): Promise<BuildQueueEntry[]> {
    const raw = await this.kv.get(KV_KEYS.BUILD.QUEUE);
    if (!raw) return [];

    const index: string[] = JSON.parse(raw);
    const entries = await Promise.all(
      index.map(async (taskId) => {
        const data = await this.kv.get(KV_KEYS.BUILD.QUEUE_ITEM(taskId));
        if (!data) return null;
        try {
          return JSON.parse(data) as BuildQueueEntry;
        } catch {
          return null;
        }
      }),
    );

    return entries
      .filter((e): e is BuildQueueEntry => e !== null)
      .sort((a, b) => {
        if (b.tier !== a.tier) {
          // Higher tier priority first — weights defined in BUILD_QUEUE_PRIORITY
          const PRIORITY: Record<SubscriptionPlan, number> = { pro: 30, indie: 20, hobby: 10 };
          return PRIORITY[b.tier] - PRIORITY[a.tier];
        }
        return a.enqueuedAt - b.enqueuedAt;
      });
  }

  /**
   * Removes a build task from the queue after it has been dispatched or
   * cancelled. Safe to call multiple times (idempotent).
   */
  async dequeueBuild(taskId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.BUILD.QUEUE_ITEM(taskId));

    const raw = await this.kv.get(KV_KEYS.BUILD.QUEUE);
    if (!raw) return;

    const index: string[] = JSON.parse(raw);
    const updated = index.filter((id) => id !== taskId);
    if (updated.length === 0) {
      await this.kv.delete(KV_KEYS.BUILD.QUEUE);
    } else {
      await this.kv.put(KV_KEYS.BUILD.QUEUE, JSON.stringify(updated), { ttl: PAYLOAD_TTL });
    }
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
