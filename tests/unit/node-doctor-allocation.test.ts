// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { NodeDoctor } from "@/lib/node/node-doctor.js";
import type { Instance } from "@/types/index.js";

let _privateKey: CryptoKey;
let _publicKeyJwk: JsonWebKey & { kid: string };

async function ensureKeyPair() {
  if (_privateKey) return;
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  _privateKey = pair.privateKey;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  _publicKeyJwk = { ...pub, kid: "test-kid" } as JsonWebKey & { kid: string };
}

function makeKv() {
  return {
    kv: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async incr() { return 1; },
    },
    instanceCache: {
      async getInFlightBuilds() { return []; },
      async clearInFlightBuilds() {},
      async checkForDecommissionFlag() { return false; },
      async setFlagForDecommission() {},
      async isInRecoveryWindow() { return false; },
    },
    payloads: { async enqueueBuild() {} },
    entities: { async getEntity() { return null; } },
    getPrivateKey: async () => _privateKey,
    getPublicKey: async () => _publicKeyJwk,
  } as any;
}

function makeConn() {
  return { emit: async () => {}, getNodeConnections: () => [], sendTask: () => false } as any;
}

function makeDoctor({
  db,
  pool = {} as any,
  vm = null,
}: {
  db: any;
  pool?: any;
  vm?: any;
}) {
  return new NodeDoctor({ db, kv: makeKv(), vm, conn: makeConn(), pool });
}

describe("NodeDoctor.allocateUnassignedCapacity — unassigned cluster routing", () => {
  before(ensureKeyPair);

  it("calls spawnDedicatedInstance for a pro cluster", async () => {
    const spawned: string[] = [];
    const allocated: string[] = [];

    const db = {
      instances: {
        list: async ({ kind }: any) => {
          if (kind === "pool") return { instances: [] };
          if (kind === "dedicated") return { instances: [] };
          return { instances: [] };
        },
        listUnassignedClusters: async () => [{ id: "cluster-pro", name: "my-cluster" }],
        addPool: async () => ({ id: "inst-1" }),
        update: async () => {},
        removePool: async () => {},
        releasePoolInstance: async () => {},
        listOrphanedDedicated: async () => [],
      },
      billing: {
        getEffectivePlan: async (clusterId: string) => clusterId === "cluster-pro" ? "pro" : "hobby",
      },
    } as any;

    const pool = {
      allocateSharedPool: async (clusterId: string) => { allocated.push(clusterId); },
      spawnDedicatedInstance: async ({ clusterId }: any) => { spawned.push(clusterId); },
    };

    const vm = { list: async () => [] } as any;
    const doctor = makeDoctor({ db, pool, vm });

    await (doctor as any).allocateUnassignedCapacity(0);

    assert.deepEqual(spawned, ["cluster-pro"], "pro cluster must get spawnDedicatedInstance");
    assert.deepEqual(allocated, [], "must not assign pro cluster to shared pool");
  });

  it("calls allocateSharedPool for hobby and indie clusters", async () => {
    const allocated: { clusterId: string; tier: string }[] = [];

    const clusters = [
      { id: "cluster-hobby", name: "hobby-cluster" },
      { id: "cluster-indie", name: "indie-cluster" },
    ];

    const db = {
      instances: {
        list: async () => ({ instances: [] }),
        listUnassignedClusters: async () => clusters,
        listOrphanedDedicated: async () => [],
        addPool: async () => ({ id: "inst-1" }),
        update: async () => {},
        removePool: async () => {},
        getRoutingKey: async () => "test-node",
      },
      billing: {
        getEffectivePlan: async (clusterId: string) =>
          clusterId === "cluster-indie" ? "indie" : "hobby",
      },
    } as any;

    const pool = {
      allocateSharedPool: async (clusterId: string, tier: string) => {
        allocated.push({ clusterId, tier });
      },
      spawnDedicatedInstance: async () => {
        throw new Error("must not call spawnDedicatedInstance for non-pro clusters");
      },
    };

    const vm = { list: async () => [] } as any;
    const doctor = makeDoctor({ db, pool, vm });

    await (doctor as any).allocateUnassignedCapacity(0);

    assert.equal(allocated.length, 2);
    assert.ok(allocated.some((a) => a.clusterId === "cluster-hobby" && a.tier === "hobby"));
    assert.ok(allocated.some((a) => a.clusterId === "cluster-indie" && a.tier === "indie"));
  });

  it("skips all allocation when pool quota is already reached", async () => {
    const spawned: string[] = [];

    const db = {
      instances: {
        listUnassignedClusters: async () => [{ id: "cluster-pro", name: "my-cluster" }],
        listOrphanedDedicated: async () => [],
        list: async () => ({ instances: [] }),
      },
      billing: { getEffectivePlan: async () => "pro" },
    } as any;

    const pool = {
      allocateSharedPool: async () => {},
      spawnDedicatedInstance: async ({ clusterId }: any) => { spawned.push(clusterId); },
    };

    const { INSTANCE_POOL_QUOTA } = await import("@/lib/constants/instances.js");
    const doctor = makeDoctor({ db, pool });

    await (doctor as any).allocateUnassignedCapacity(INSTANCE_POOL_QUOTA);

    assert.deepEqual(spawned, [], "must not allocate when pool quota is already at limit");
  });
});

describe("NodeDoctor.migrateClusters — tier routing", () => {
  before(ensureKeyPair);

  it("passes the cluster's effective tier to allocateSharedPool", async () => {
    const allocateCalls: { clusterId: string; tier: string }[] = [];

    const db = {
      billing: {
        getEffectivePlan: async (clusterId: string) =>
          clusterId === "cluster-indie" ? "indie" : "hobby",
      },
      instances: {
        list: async () => ({ instances: [] }),
        listOrphanedDedicated: async () => [],
        releasePoolInstance: async () => {},
        getRoutingKey: async () => "test-node",
      },
      clusters: { find: async () => null },
    } as any;

    const pool = {
      allocateSharedPool: async (clusterId: string, tier: string) => {
        allocateCalls.push({ clusterId, tier });
      },
    };

    const doctor = makeDoctor({ db, pool });

    const allMigrated = await (doctor as any).migrateClusters(["cluster-hobby", "cluster-indie"]);

    assert.equal(allMigrated, true);
    assert.ok(
      allocateCalls.some((c) => c.clusterId === "cluster-hobby" && c.tier === "hobby"),
      "hobby cluster must be assigned to hobby pool",
    );
    assert.ok(
      allocateCalls.some((c) => c.clusterId === "cluster-indie" && c.tier === "indie"),
      "indie cluster must be assigned to indie pool",
    );
  });

  it("returns false and continues when one cluster migration fails", async () => {
    const migrated: string[] = [];

    const db = {
      billing: { getEffectivePlan: async () => "hobby" },
      instances: { list: async () => ({ instances: [] }), listOrphanedDedicated: async () => [], releasePoolInstance: async () => {}, getRoutingKey: async () => "test-node" },
      clusters: { find: async () => null },
    } as any;

    const pool = {
      allocateSharedPool: async (clusterId: string) => {
        if (clusterId === "cluster-fail") throw new Error("pool full");
        migrated.push(clusterId);
      },
    };

    const doctor = makeDoctor({ db, pool });
    const result = await (doctor as any).migrateClusters(["cluster-ok", "cluster-fail"]);

    assert.equal(result, false, "should return false when any cluster fails to migrate");
    assert.deepEqual(migrated, ["cluster-ok"], "should still migrate the successful cluster");
  });
});

describe("NodeDoctor.cleanupOrphanedDedicatedInstances — orphan cleanup", () => {
  function makeOrphanedInstance(tag: string): Partial<Instance> {
    return { id: `id-${tag}`, tag, kind: "dedicated" as any, status: "offline" as any };
  }

  it("destroys VM droplet and removes DB record for orphaned dedicated instances", async () => {
    const deleted: string[] = [];
    const dbRemoved: string[] = [];

    const orphaned = [makeOrphanedInstance("orphan-tag-1"), makeOrphanedInstance("orphan-tag-2")];

    const db = {
      instances: {
        list: async ({ kind }: any) => {
          if (kind === "pool") return { instances: [] };
          if (kind === "dedicated") return { instances: orphaned };
          return { instances: [] };
        },
        listUnassignedClusters: async () => [],
        listOrphanedDedicated: async () => orphaned,
        addPool: async () => ({ id: "inst-1" }),
        update: async () => {},
        removePool: async (id: string) => { dbRemoved.push(id); },
      },
      billing: { getEffectivePlan: async () => "hobby" },
    } as any;

    const vm = {
      list: async ({ tagName }: any) => orphaned.map((o: any) => ({
        name: o.tag,
        ipv4: "1.2.3.4",
        region: "nyc3",
        status: "active",
        tags: ["dployr-managed"],
      })),
      delete: async (tag: string) => { deleted.push(tag); },
    } as any;

    const doctor = makeDoctor({ db, pool: {} as any, vm });

    const dropletMap = new Map(
      orphaned.map((o: any) => [o.tag, { name: o.tag, tags: ["dployr-managed"] }]),
    );

    await (doctor as any).cleanupOrphanedDedicatedInstances(dropletMap);

    assert.deepEqual(deleted.sort(), ["orphan-tag-1", "orphan-tag-2"], "must delete both orphaned VMs");
    assert.deepEqual(dbRemoved.sort(), ["id-orphan-tag-1", "id-orphan-tag-2"], "must remove both DB records");
  });

  it("does nothing when no orphaned dedicated instances exist", async () => {
    const deleted: string[] = [];

    const db = {
      instances: {
        list: async () => ({ instances: [] }),
        listUnassignedClusters: async () => [],
        listOrphanedDedicated: async () => [],
      },
      billing: { getEffectivePlan: async () => "hobby" },
    } as any;

    const vm = {
      list: async () => [],
      delete: async (tag: string) => { deleted.push(tag); },
    } as any;

    const doctor = makeDoctor({ db, pool: {} as any, vm });
    await (doctor as any).cleanupOrphanedDedicatedInstances(new Map());

    assert.deepEqual(deleted, [], "must not delete anything when no orphans exist");
  });
});

describe("NodeDoctor.buildNodeReconcile — in-flight build re-queueing", () => {
  it("re-queues in-flight builds from a degraded build node", async () => {
    const requeued: string[] = [];
    const inFlight = [
      { taskId: "task-1", clusterId: "cluster-a" },
      { taskId: "task-2", clusterId: "cluster-b" },
    ];

    const db = {
      instances: {
        list: async () => ({ instances: [{ id: "node-1", tag: "build-degraded", status: "degraded", role: "build" }] }),
      },
    } as any;

    const kv = {
      instanceCache: {
        getInFlightBuilds: async (tag: string) => tag === "build-degraded" ? inFlight : [],
        clearInFlightBuilds: async () => {},
      },
      payloads: {
        enqueueBuild: async (entry: any) => { requeued.push(entry.taskId); },
      },
      kv: { delete: async () => {} },
    } as any;

    const pool = { spawnBuildNode: async () => {} };

    const doctor = new NodeDoctor({
      db,
      kv,
      vm: null,
      conn: makeConn(),
      pool: pool as any,
      desiredBuildNodeCapacity: 0,
    });

    await doctor.buildNodeReconcile();

    assert.deepEqual(requeued.sort(), ["task-1", "task-2"], "must re-queue all in-flight builds from degraded node");
  });

  it("does not re-queue builds from healthy nodes", async () => {
    const requeued: string[] = [];

    const db = {
      instances: {
        list: async () => ({
          instances: [{ id: "node-1", tag: "build-healthy", status: "healthy", role: "build" }],
        }),
      },
    } as any;

    const kv = {
      instanceCache: {
        getInFlightBuilds: async () => [{ taskId: "task-1", clusterId: "cluster-a" }],
        clearInFlightBuilds: async () => {},
      },
      payloads: {
        enqueueBuild: async (entry: any) => { requeued.push(entry.taskId); },
      },
      kv: { delete: async () => {} },
    } as any;

    const doctor = new NodeDoctor({
      db,
      kv,
      vm: null,
      conn: makeConn(),
      pool: { spawnBuildNode: async () => {} } as any,
      desiredBuildNodeCapacity: 1,
    });

    await doctor.buildNodeReconcile();

    assert.deepEqual(requeued, [], "must not re-queue builds from a healthy node");
  });
});
