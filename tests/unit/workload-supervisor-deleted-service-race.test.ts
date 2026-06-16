// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string; address?: string };
type FakeService = { id: string; name: string; type: string; clusterId: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string };

function makeDb(clusters: FakeCluster[], services: FakeService[], instances: FakeInstance[]) {
  const upsertCalls: string[] = [];

  const db = {
    instances: {
      find: async (filter: any) => {
        if (filter.id) return instances.find(i => i.id === filter.id) ?? null;
        if (filter.tag) return instances.find(i => i.tag === filter.tag) ?? null;
        if (filter.clusterId && filter.kind) return instances.find(i => i.clusterId === filter.clusterId && i.kind === filter.kind) ?? null;
        return null;
      },
    },
    deployments: {
      list: async () => ({ deployments: [] }),
    },
    clusters: { list: async () => ({ clusters }) },
    services: {
      list: async (filter: any) => ({ services: services.filter(s => s.clusterId === filter.clusterId) }),
      upsert: async (data: any) => { upsertCalls.push(data.name); },
    },
    serviceSecrets: null,
    _upsertCalls: upsertCalls,
  } as any;

  return db;
}

function makeKv({
  nodeWorkloads = {} as Record<string, any[]>,
  deletedTombstones = [] as string[],
  sleepingFlags = {} as Record<string, string>,
}) {
  const kvStore: Record<string, string> = {
    ...Object.fromEntries(deletedTombstones.map(name => [KV_KEYS.SERVICE.DELETED(name), "1"])),
    ...Object.fromEntries(Object.entries(sleepingFlags).map(([name, v]) => [KV_KEYS.SERVICE.SLEEPING(name), v])),
  };

  return {
    entities: {
      getEntity: async (key: string) => {
        for (const [tag, svcs] of Object.entries(nodeWorkloads)) {
          if (key === KV_KEYS.INSTANCE.ENTITY(tag, "workloads")) {
            return { data: { services: svcs }, version: 1 };
          }
        }
        return null;
      },
    },
    instanceCache: { registerClusterNode: async () => {}, deregisterClusterNode: async () => {} },
    kv: {
      get: async (key: string) => kvStore[key] ?? null,
      put: async (key: string, value: string) => { kvStore[key] = value; },
      delete: async (key: string) => { delete kvStore[key]; },
    },
    _store: kvStore,
  } as any;
}

function makeConnectionManager(connectedTags: string[]) {
  return {
    hasNodeConnection: (tag: string) => connectedTags.includes(tag),
    sendTask: () => false,
    getNodeConnectionsByClusterId: (_id: string) => [],
  } as any;
}

function makeNotifier() {
  return {
    notifyRefresh: () => {},
    broadcast: async () => {},
    _calls: [] as string[],
  } as any;
}

const noopJwt = { createNodeAccessToken: async () => "tok" } as any;

describe("WorkloadSupervisor — deleted-service re-creation race", () => {
  it("does NOT re-create a service when DELETED tombstone is present", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };

    // DB has no services — user deleted "ronaldo"
    const db = makeDb([cluster], [], [instance]);
    const kv = makeKv({
      // Node re-created the service via an in-flight build/publish task
      nodeWorkloads: { "node-1": [{ name: "ronaldo", type: "web" }] },
      // Tombstone was written by the DELETE route handler
      deletedTombstones: ["ronaldo"],
    });

    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier());
    await supervisor.run();

    assert.deepEqual(db._upsertCalls, [], "upsert must not be called for a service with an active DELETED tombstone");
  });

  it("re-creates a service normally when NO tombstone is present", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };

    // DB has no services (e.g. first deployment, base DB hasn't been written yet)
    const db = makeDb([cluster], [], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "api", type: "web" }] },
      // no tombstone
    });

    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier());
    await supervisor.run();

    assert.ok(db._upsertCalls.includes("api"), "upsert must be called when service is on node but not in DB and no tombstone");
  });

  it("blocks only the tombstoned service and allows others to be created", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };

    // "ronaldo" was deleted; "api" is a genuinely new service
    const db = makeDb([cluster], [], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "ronaldo", type: "web" }, { name: "api", type: "web" }] },
      deletedTombstones: ["ronaldo"],
    });

    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier());
    await supervisor.run();

    assert.ok(db._upsertCalls.includes("api"), "api should be created normally");
    assert.ok(!db._upsertCalls.includes("ronaldo"), "ronaldo must not be re-created while tombstone is active");
  });

  it("allows re-creation once tombstone expires (TTL elapsed / key absent)", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };

    // Same scenario but tombstone has expired — someone re-deployed "ronaldo" legitimately
    const db = makeDb([cluster], [], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "ronaldo", type: "web" }] },
      // tombstone absent (expired or never set)
    });

    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier());
    await supervisor.run();

    assert.ok(db._upsertCalls.includes("ronaldo"), "re-creation must proceed once tombstone is gone");
  });

  it("does NOT block a service that is already present in DB (tombstone irrelevant)", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const existingService: FakeService = { id: "s1", name: "ronaldo", type: "web", clusterId: "c1" };

    // Service is in DB — it's NOT in toCreate, so tombstone check is never reached
    const db = makeDb([cluster], [existingService], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "ronaldo", type: "web" }] },
      deletedTombstones: ["ronaldo"],
    });

    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier());
    await supervisor.run();

    // upsert would only be called for toCreate entries; existing DB service is not in toCreate
    assert.deepEqual(db._upsertCalls, [], "no upsert needed — service already in DB");
  });
});
