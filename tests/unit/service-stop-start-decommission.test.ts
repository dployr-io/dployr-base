// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { SERVICE_WAKING_TTL } from "@/lib/constants/duration.js";


function makeKvStore(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const ttls: Record<string, number> = {};
  const deleted = new Set<string>();
  return {
    store,
    ttls,
    deleted,
    kv: {
      get: async (key: string) => store[key] ?? null,
      put: async (key: string, value: string, opts?: { ttl?: number }) => {
        store[key] = value;
        if (opts?.ttl) ttls[key] = opts.ttl;
      },
      delete: async (key: string) => {
        delete store[key];
        deleted.add(key);
      },
    },
  };
}

function makeTraefik() {
  const loadingModeCalls: string[] = [];
  const unregisterCalls: string[] = [];
  return {
    loadingModeCalls,
    unregisterCalls,
    setLoadingMode: async (name: string) => { loadingModeCalls.push(name); },
    unregisterRoute: async (name: string) => { unregisterCalls.push(name); },
  };
}

function makeDb(routingKey: string | null, dedicatedTag: string | null = null) {
  return {
    instances: {
      // mirrors the route's old (broken) guard: find({ clusterId, kind: "dedicated" })
      findDedicated: async () => dedicatedTag ? { tag: dedicatedTag } : null,
      // mirrors the fixed route: getRoutingKey handles both pool and dedicated
      getRoutingKey: async (_clusterId: string) => routingKey ?? _clusterId,
    },
  };
}

function makeConnectionManager(connectedKeys: string[]) {
  return {
    sendTask: (routingKey: string | null, _task: any) =>
      routingKey !== null && connectedKeys.includes(routingKey),
  };
}

// Simulates the full POST /:id/stop route logic including routing key resolution
async function runStopLogic(
  serviceName: string,
  clusterId: string,
  db: ReturnType<typeof makeDb>,
  kv: ReturnType<typeof makeKvStore>,
  traefik: ReturnType<typeof makeTraefik> | null,
  connectionManager: ReturnType<typeof makeConnectionManager>,
): Promise<{ sent: boolean; error?: string }> {
  const routingKey = await db.instances.getRoutingKey(clusterId);
  const sent = connectionManager.sendTask(routingKey, { Type: `services/sleep?name=${serviceName}:post` });
  if (!sent) return { sent, error: "No node connected to this cluster" };
  await Promise.all([
    kv.kv.put(KV_KEYS.SERVICE.SLEEPING(serviceName), "1"),
    traefik ? traefik.setLoadingMode(serviceName) : Promise.resolve(),
  ]);
  return { sent };
}

// Simulates the full POST /:id/start route logic including routing key resolution
async function runStartLogic(
  serviceName: string,
  clusterId: string,
  db: ReturnType<typeof makeDb>,
  kv: ReturnType<typeof makeKvStore>,
  connectionManager: ReturnType<typeof makeConnectionManager>,
): Promise<{ sent: boolean; error?: string }> {
  const routingKey = await db.instances.getRoutingKey(clusterId);
  const sent = connectionManager.sendTask(routingKey, { Type: `services/wake?name=${serviceName}:post` });
  if (!sent) return { sent, error: "No node connected to this cluster" };
  await Promise.all([
    kv.kv.delete(KV_KEYS.SERVICE.SLEEPING(serviceName)),
    kv.kv.put(KV_KEYS.SERVICE.WAKING(serviceName), "1", { ttl: SERVICE_WAKING_TTL }),
  ]);
  return { sent };
}

// Simulates the full DELETE /:id route logic including routing key resolution and task dispatch
async function runDecommissionLogic(
  serviceName: string,
  serviceId: string,
  clusterId: string,
  instanceDb: ReturnType<typeof makeDb>,
  kv: ReturnType<typeof makeKvStore>,
  traefik: ReturnType<typeof makeTraefik> | null,
  connectionManager: ReturnType<typeof makeConnectionManager>,
  db: { deletedIds: string[] },
) {
  const routingKey = await instanceDb.instances.getRoutingKey(clusterId);
  connectionManager.sendTask(routingKey, { Type: `services/${serviceName}:delete` });

  if (traefik) await traefik.unregisterRoute(serviceName);
  await Promise.all([
    kv.kv.delete(KV_KEYS.SERVICE.SLEEPING(serviceName)),
    kv.kv.delete(KV_KEYS.SERVICE.WAKING(serviceName)),
    kv.kv.delete(KV_KEYS.SERVICE.LAST_ACTIVE(serviceName)),
    kv.kv.delete(KV_KEYS.SERVICE.HEALTH(serviceName)),
  ]);
  db.deletedIds.push(serviceId);
}


describe("service stop — KV + Traefik state transitions", () => {
  it("sets SLEEPING flag and calls setLoadingMode when task is delivered", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore();
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);

    const { sent } = await runStopLogic("api", "cluster-1", db, kv, traefik, cm);

    assert.ok(sent);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], "1");
    assert.deepEqual(traefik.loadingModeCalls, ["api"]);
  });

  it("does NOT set SLEEPING or call setLoadingMode when node is unreachable (sent=false)", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore();
    const traefik = makeTraefik();
    const cm = makeConnectionManager([]);

    const { sent } = await runStopLogic("api", "cluster-1", db, kv, traefik, cm);

    assert.ok(!sent);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], undefined);
    assert.equal(traefik.loadingModeCalls.length, 0);
  });

  it("sets SLEEPING even when Traefik is not configured", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore();
    const cm = makeConnectionManager(["node-1"]);

    const { sent } = await runStopLogic("api", "cluster-1", db, kv, null, cm);

    assert.ok(sent);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], "1");
  });

  it("sets SLEEPING for a service that was already waking (idempotent stop)", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore({ [KV_KEYS.SERVICE.WAKING("api")]: "1" });
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);

    await runStopLogic("api", "cluster-1", db, kv, traefik, cm);

    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], "1");
    assert.deepEqual(traefik.loadingModeCalls, ["api"]);
  });

  it("works for pool cluster (no dedicated instance — getRoutingKey resolves pool tag)", async () => {
    // This is the bug that was previously invisible: stop guarded with find({ kind: "dedicated" })
    // which returned null for pool clusters, so the error fired before sendTask was ever called.
    // The fix: use getRoutingKey directly (handles both pool and dedicated).
    const db = makeDb("pool-node-1");  // pool routing key, no dedicated instance
    const kv = makeKvStore();
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["pool-node-1"]);

    const { sent } = await runStopLogic("api", "hobby-cluster", db, kv, traefik, cm);

    assert.ok(sent, "stop must work for pool/hobby clusters");
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], "1");
  });
});

describe("service start — KV state transitions", () => {
  it("deletes SLEEPING and sets WAKING with TTL when task is delivered", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore({ [KV_KEYS.SERVICE.SLEEPING("api")]: "1" });
    const cm = makeConnectionManager(["node-1"]);

    const { sent } = await runStartLogic("api", "cluster-1", db, kv, cm);

    assert.ok(sent);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], undefined, "SLEEPING must be cleared");
    assert.ok(kv.deleted.has(KV_KEYS.SERVICE.SLEEPING("api")));
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], "1", "WAKING must be set");
    assert.equal(kv.ttls[KV_KEYS.SERVICE.WAKING("api")], SERVICE_WAKING_TTL, "WAKING must carry TTL");
  });

  it("does NOT modify KV when node is unreachable (sent=false)", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore({ [KV_KEYS.SERVICE.SLEEPING("api")]: "1" });
    const cm = makeConnectionManager([]);

    const { sent } = await runStartLogic("api", "cluster-1", db, kv, cm);

    assert.ok(!sent);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], "1", "SLEEPING must remain");
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], undefined, "WAKING must NOT be set");
  });

  it("sets WAKING even if SLEEPING was already absent (manual start on running service)", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore();
    const cm = makeConnectionManager(["node-1"]);

    const { sent } = await runStartLogic("api", "cluster-1", db, kv, cm);

    assert.ok(sent);
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], "1");
  });

  it("WAKING is NOT set when SLEEPING is deleted (avoids loading page stuck on 'ready' before Traefik is restored)", async () => {
    // The key invariant: after start, status must return "starting" (WAKING present)
    // not "ready" (neither flag). If WAKING were deleted instead of set,
    // the loading page would reload before the node is up.
    const db = makeDb("node-1");
    const kv = makeKvStore({ [KV_KEYS.SERVICE.SLEEPING("api")]: "1" });
    const cm = makeConnectionManager(["node-1"]);

    await runStartLogic("api", "cluster-1", db, kv, cm);

    const sleeping = kv.store[KV_KEYS.SERVICE.SLEEPING("api")];
    const waking = kv.store[KV_KEYS.SERVICE.WAKING("api")];

    assert.equal(sleeping, undefined, "SLEEPING cleared");
    assert.equal(waking, "1", "WAKING set — status returns 'starting', not 'ready'");
  });

  it("works for pool cluster (no dedicated instance — getRoutingKey resolves pool tag)", async () => {
    const db = makeDb("pool-node-1");
    const kv = makeKvStore({ [KV_KEYS.SERVICE.SLEEPING("api")]: "1" });
    const cm = makeConnectionManager(["pool-node-1"]);

    const { sent } = await runStartLogic("api", "hobby-cluster", db, kv, cm);

    assert.ok(sent, "start must work for pool/hobby clusters");
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], "1");
  });
});

describe("service decommission — task dispatch + KV cleanup + Traefik + DB", () => {
  it("dispatches remove task, unregisters Traefik route, and deletes all KV keys", async () => {
    const instanceDb = makeDb("node-1");
    const kv = makeKvStore({
      [KV_KEYS.SERVICE.SLEEPING("api")]: "1",
      [KV_KEYS.SERVICE.WAKING("api")]: "1",
      [KV_KEYS.SERVICE.LAST_ACTIVE("api")]: String(Date.now()),
      [KV_KEYS.SERVICE.HEALTH("api")]: "healthy",
    });
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);
    const db = { deletedIds: [] as string[] };

    await runDecommissionLogic("api", "svc-1", "cluster-1", instanceDb, kv, traefik, cm, db);

    assert.deepEqual(traefik.unregisterCalls, ["api"]);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], undefined);
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], undefined);
    assert.equal(kv.store[KV_KEYS.SERVICE.LAST_ACTIVE("api")], undefined);
    assert.equal(kv.store[KV_KEYS.SERVICE.HEALTH("api")], undefined);
    assert.deepEqual(db.deletedIds, ["svc-1"]);
  });

  it("dispatches remove task to pool node (not only dedicated instances)", async () => {
    const instanceDb = makeDb("pool-node-1");
    const kv = makeKvStore();
    const traefik = makeTraefik();
    const tasksSent: string[] = [];
    const cm = { sendTask: (rk: string | null, _t: any) => { if (rk) tasksSent.push(rk); return true; } };
    const db = { deletedIds: [] as string[] };

    await runDecommissionLogic("api", "svc-1", "hobby-cluster", instanceDb, kv, traefik, cm, db);

    assert.deepEqual(tasksSent, ["pool-node-1"], "remove task must be sent to the pool routing key");
    assert.deepEqual(db.deletedIds, ["svc-1"]);
  });

  it("cleans up KV even when no flags were set (idempotent)", async () => {
    const instanceDb = makeDb("node-1");
    const kv = makeKvStore();
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);
    const db = { deletedIds: [] as string[] };

    await assert.doesNotReject(() => runDecommissionLogic("api", "svc-1", "cluster-1", instanceDb, kv, traefik, cm, db));
    assert.deepEqual(db.deletedIds, ["svc-1"]);
  });

  it("proceeds with KV cleanup and DB delete even without Traefik configured", async () => {
    const instanceDb = makeDb("node-1");
    const kv = makeKvStore({ [KV_KEYS.SERVICE.SLEEPING("api")]: "1" });
    const cm = makeConnectionManager(["node-1"]);
    const db = { deletedIds: [] as string[] };

    await runDecommissionLogic("api", "svc-1", "cluster-1", instanceDb, kv, null, cm, db);

    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], undefined);
    assert.deepEqual(db.deletedIds, ["svc-1"]);
  });

  it("does not leave stale SLEEPING that could trigger spurious wake tasks via status endpoint", async () => {
    const instanceDb = makeDb("node-1");
    const kv = makeKvStore({ [KV_KEYS.SERVICE.SLEEPING("api")]: "1" });
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);
    const db = { deletedIds: [] as string[] };

    await runDecommissionLogic("api", "svc-1", "cluster-1", instanceDb, kv, traefik, cm, db);

    assert.equal(
      kv.store[KV_KEYS.SERVICE.SLEEPING("api")],
      undefined,
      "stale SLEEPING would cause status endpoint to fire wake task for a deleted service",
    );
  });

  it("cleans up all four KV keys independently — partial state is also handled", async () => {
    const instanceDb = makeDb("node-1");
    const kv = makeKvStore({
      [KV_KEYS.SERVICE.SLEEPING("api")]: "1",
      [KV_KEYS.SERVICE.HEALTH("api")]: "degraded",
    });
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);
    const db = { deletedIds: [] as string[] };

    await runDecommissionLogic("api", "svc-1", "cluster-1", instanceDb, kv, traefik, cm, db);

    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], undefined);
    assert.equal(kv.store[KV_KEYS.SERVICE.HEALTH("api")], undefined);
    assert.deepEqual(db.deletedIds, ["svc-1"]);
  });
});

describe("stop → start round-trip KV invariants", () => {
  it("SLEEPING set on stop, clearNo node connected to this clustered on start, WAKING set — status returns 'starting' throughout wake", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore();
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);

    // Stop
    await runStopLogic("api", "cluster-1", db, kv, traefik, cm);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], "1");
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], undefined);

    // Start
    await runStartLogic("api", "cluster-1", db, kv, cm);
    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], undefined, "SLEEPING cleared on start");
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], "1", "WAKING set on start");
    assert.equal(kv.ttls[KV_KEYS.SERVICE.WAKING("api")], SERVICE_WAKING_TTL, "WAKING expires automatically");
  });

  it("double-stop does not leave WAKING set", async () => {
    const db = makeDb("node-1");
    const kv = makeKvStore();
    const traefik = makeTraefik();
    const cm = makeConnectionManager(["node-1"]);

    await runStopLogic("api", "cluster-1", db, kv, traefik, cm);
    await runStopLogic("api", "cluster-1", db, kv, traefik, cm);

    assert.equal(kv.store[KV_KEYS.SERVICE.SLEEPING("api")], "1");
    assert.equal(kv.store[KV_KEYS.SERVICE.WAKING("api")], undefined);
  });
});
