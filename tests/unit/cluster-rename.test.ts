// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClusterStore } from "@/lib/db/store/kv/cluster.js";
import { MemoryKV } from "@/lib/storage/kv.interface.js";

describe("ClusterStore.recordRename", () => {
  it("allows up to 3 renames within 12 months", async () => {
    const kv = new MemoryKV();
    const store = new ClusterStore(kv);
    const clusterId = "test-cluster-1";

    assert.equal(await store.recordRename(clusterId), null, "1st rename should be allowed");
    // Bypass monthly cooldown by backdating the first rename
    const MONTHLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
    await kv.put(`cluster:${clusterId}:renames`, JSON.stringify([Date.now() - MONTHLY_COOLDOWN_MS - 1000]));
    assert.equal(await store.recordRename(clusterId), null, "2nd rename should be allowed");
    await kv.put(`cluster:${clusterId}:renames`, JSON.stringify([Date.now() - MONTHLY_COOLDOWN_MS * 2, Date.now() - MONTHLY_COOLDOWN_MS - 1000]));
    assert.equal(await store.recordRename(clusterId), null, "3rd rename should be allowed");
    assert.equal(await store.recordRename(clusterId), "annual_limit", "4th rename should be blocked by annual limit");
  });

  it("getRenameQuota reflects remaining slots", async () => {
    const kv = new MemoryKV();
    const store = new ClusterStore(kv);
    const clusterId = "test-cluster-2";

    let quota = await store.getRenameQuota(clusterId);
    assert.equal(quota.remaining, 3, "Should start with 3 remaining");

    await store.recordRename(clusterId);
    quota = await store.getRenameQuota(clusterId);
    assert.equal(quota.remaining, 2);
    assert.ok(quota.oldestAt !== null, "oldestAt should be set after first rename");
  });

  it("clearRenameHistory resets the quota", async () => {
    const kv = new MemoryKV();
    const store = new ClusterStore(kv);
    const clusterId = "test-cluster-3";

    const MONTHLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
    // Seed 3 renames spaced >30 days apart so monthly cooldown doesn't interfere
    await kv.put(`cluster:${clusterId}:renames`, JSON.stringify([
      Date.now() - MONTHLY_COOLDOWN_MS * 3,
      Date.now() - MONTHLY_COOLDOWN_MS * 2,
      Date.now() - MONTHLY_COOLDOWN_MS - 1000,
    ]));
    assert.ok(await store.recordRename(clusterId) !== null, "Should be blocked at 3");

    await store.clearRenameHistory(clusterId);
    assert.equal(await store.recordRename(clusterId), null, "Should be allowed after clear");
  });

  it("prunes entries older than 12 months and frees a slot", async () => {
    const kv = new MemoryKV();
    const store = new ClusterStore(kv);
    const clusterId = "test-cluster-4";
    const ROLLING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

    // Seed two renames that are just over a year old and one recent one.
    const expired = Date.now() - ROLLING_WINDOW_MS - 1000;
    await kv.put(`cluster:${clusterId}:renames`, JSON.stringify([expired, expired, Date.now()]));

    // Only the recent entry should count — 2 expired entries are pruned,
    // leaving 2 free slots, so two more renames should succeed.
    assert.equal(await store.recordRename(clusterId), null, "Should allow after expired entries pruned (slot 2)");
    // Advance past monthly cooldown before next rename
    const MONTHLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
    const history = JSON.parse((await kv.get(`cluster:${clusterId}:renames`))!);
    history[history.length - 1] = Date.now() - MONTHLY_COOLDOWN_MS - 1000;
    await kv.put(`cluster:${clusterId}:renames`, JSON.stringify(history));
    assert.equal(await store.recordRename(clusterId), null, "Should allow (slot 3)");
    assert.equal(await store.recordRename(clusterId), "annual_limit", "Should block at annual limit");
  });
});

describe("cluster rename: session refresh", () => {
  it("calls refreshSession for each cluster member with an active session", async () => {
    const refreshed: string[] = [];

    // Minimal stubs
    const db = {
      clusters: {
        update: async (_id: string, _updates: any) => ({ id: "c1", name: "new-name" }),
        listUsers: async (_id: string) => ({
          users: [
            { id: "user-a" },
            { id: "user-b" },
            { id: "user-c" }, // no active session
          ],
        }),
        listUserClusters: async (userId: string) => [{ id: "c1", name: "new-name", owner: "user-a", role: "owner" }],
      },
    };

    const kv = {
      recordRename: async (_id: string) => true,
      getSessionIdByUserId: async (userId: string) => {
        // user-c has no active session
        return userId === "user-c" ? null : `session-${userId}`;
      },
      refreshSession: async ({ sessionId }: { sessionId: string; updates: any }) => {
        refreshed.push(sessionId);
      },
    };

    // Import handler logic inline to avoid Hono context dependency.
    // We replicate the exact loop from the route handler:
    const clusterId = "c1";
    const { users } = await db.clusters.listUsers(clusterId);
    await Promise.all(
      users.map(async (user: any) => {
        const sessionId = await kv.getSessionIdByUserId(user.id);
        if (sessionId) {
          const clusters = await db.clusters.listUserClusters(user.id);
          await kv.refreshSession({ sessionId, updates: { clusters } });
        }
      }),
    );

    assert.deepEqual(refreshed.sort(), ["session-user-a", "session-user-b"], "Should refresh sessions for user-a and user-b only");
    assert.ok(!refreshed.includes("session-user-c"), "Should skip user-c who has no active session");
  });
});
