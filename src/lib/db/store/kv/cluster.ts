// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

const RENAME_LIMIT = 3;
const ROLLING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // 12 months
const MONTHLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type RenameBlock = "monthly_cooldown" | "annual_limit";

export class ClusterStore {
  constructor(private kv: IKVAdapter) {}

  private async getRenameTimestamps(clusterId: string): Promise<number[]> {
    const raw = await this.kv.get(KV_KEYS.CLUSTER.RENAME_HISTORY(clusterId));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as number[];
    } catch {
      return [];
    }
  }

  /**
   * Returns quota info for the cluster.
   * - `remaining`: annual slots left
   * - `oldestAt`: oldest active rename timestamp (for annual slot expiry)
   * - `lastRenameAt`: most recent rename timestamp (for monthly cooldown expiry)
   */
  async getRenameQuota(clusterId: string): Promise<{ remaining: number; oldestAt: number | null; lastRenameAt: number | null }> {
    const now = Date.now();
    const active = (await this.getRenameTimestamps(clusterId)).filter((t) => t > now - ROLLING_WINDOW_MS);
    return {
      remaining: Math.max(0, RENAME_LIMIT - active.length),
      oldestAt: active.length > 0 ? Math.min(...active) : null,
      lastRenameAt: active.length > 0 ? Math.max(...active) : null,
    };
  }

  /**
   * Records a rename timestamp.
   * Returns `null` on success, or the block reason if denied.
   */
  async recordRename(clusterId: string): Promise<RenameBlock | null> {
    const now = Date.now();
    const active = (await this.getRenameTimestamps(clusterId)).filter((t) => t > now - ROLLING_WINDOW_MS);

    // Monthly cooldown: block if any rename in the last 30 days
    const lastRename = active.length > 0 ? Math.max(...active) : null;
    if (lastRename !== null && now - lastRename < MONTHLY_COOLDOWN_MS) {
      return "monthly_cooldown";
    }

    // Annual cap
    if (active.length >= RENAME_LIMIT) {
      return "annual_limit";
    }

    active.push(now);
    await this.kv.put(KV_KEYS.CLUSTER.RENAME_HISTORY(clusterId), JSON.stringify(active));
    return null;
  }

  /**
   * Clears the rename history for a cluster. Used by support to unlock a cluster.
   */
  async clearRenameHistory(clusterId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.CLUSTER.RENAME_HISTORY(clusterId));
  }
}
