// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { SERVICE_STUB_ADDRESS } from "@/lib/constants/index.js";

type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string; address?: string };
type FakeService = { id: string; name: string; type: string; clusterId: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string };

function makeDb(clusters: FakeCluster[], services: FakeService[], instances: FakeInstance[], plan = "hobby") {
  return {
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
      upsert: async () => {},
    },
    billing: { get: async (_id: string) => ({ plan }) },
    serviceSecrets: null,
  } as any;
}

function makeKv({
  nodeWorkloads = {} as Record<string, any[]>,
  sleepingFlags = {} as Record<string, string>,
  clusterSleepingSet = {} as Record<string, string>,
  healthFlags = {} as Record<string, string>,
}) {
  const kvStore: Record<string, string> = {
    ...Object.fromEntries(Object.entries(sleepingFlags).map(([name, v]) => [KV_KEYS.SERVICE.SLEEPING(name), v])),
    ...Object.fromEntries(Object.entries(clusterSleepingSet).map(([id, v]) => [KV_KEYS.CLUSTER.SLEEPING_SERVICES(id), v])),
    ...Object.fromEntries(Object.entries(healthFlags).map(([name, v]) => [KV_KEYS.SERVICE.HEALTH(name), v])),
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
  const calls: string[] = [];
  return {
    notifyRefresh: (clusterId: string) => { calls.push(clusterId); },
    broadcast: async () => {},
    _calls: calls,
  } as any;
}

const noopJwt = { createNodeAccessToken: async () => "tok" } as any;

describe("WorkloadSupervisor — sleeping reconciliation", () => {
  it("populates cluster sleeping set when SLEEPING flag is set and service is not running", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const service: FakeService = { id: "s1", name: "ronaldo", type: "web", clusterId: "c1" };

    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [] },  // container stopped, node reports nothing
      sleepingFlags: { "ronaldo": "1" },
    });
    const notifier = makeNotifier();
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

    await supervisor.run();

    const stored = kv._store[KV_KEYS.CLUSTER.SLEEPING_SERVICES("c1")];
    assert.deepEqual(JSON.parse(stored), ["ronaldo"]);
  });

  it("triggers notifyRefresh when sleeping set changes", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const service: FakeService = { id: "s1", name: "ronaldo", type: "web", clusterId: "c1" };

    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [] },
      sleepingFlags: { "ronaldo": "1" },
      // cluster sleeping set starts empty — change will be detected
    });
    const notifier = makeNotifier();
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

    await supervisor.run();

    assert.ok(notifier._calls.includes("c1"), "notifyRefresh should be called when sleeping set changes");
  });

  it("does NOT trigger notifyRefresh when sleeping set is unchanged", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const service: FakeService = { id: "s1", name: "ronaldo", type: "web", clusterId: "c1" };

    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [] },
      sleepingFlags: { "ronaldo": "1" },
      clusterSleepingSet: { "c1": JSON.stringify(["ronaldo"]) },  // already up to date
    });
    const notifier = makeNotifier();
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

    await supervisor.run();

    assert.equal(notifier._calls.length, 0, "notifyRefresh should NOT be called when nothing changed");
  });

  it("clears SLEEPING flag and removes from cluster set when node reports service as running", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const service: FakeService = { id: "s1", name: "ronaldo", type: "web", clusterId: "c1" };

    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "ronaldo", type: "web" }] },  // service is back running
      sleepingFlags: { "ronaldo": "1" },
      clusterSleepingSet: { "c1": JSON.stringify(["ronaldo"]) },
      healthFlags: { "ronaldo": "healthy" },
    });
    const notifier = makeNotifier();
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

    await supervisor.run();

    assert.equal(kv._store[KV_KEYS.SERVICE.SLEEPING("ronaldo")], undefined, "SLEEPING flag should be deleted");
    const stored = kv._store[KV_KEYS.CLUSTER.SLEEPING_SERVICES("c1")];
    assert.deepEqual(JSON.parse(stored), [], "cluster sleeping set should be empty");
    assert.ok(notifier._calls.includes("c1"), "notifyRefresh should fire when service wakes up");
  });

  it("clears SLEEPING flag when service is running and health key is absent", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const service: FakeService = { id: "s1", name: "ronaldo", type: "web", clusterId: "c1" };

    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "ronaldo", type: "web" }] },
      sleepingFlags: { "ronaldo": "1" },
      clusterSleepingSet: { "c1": JSON.stringify(["ronaldo"]) },
      // no healthFlags — health key never written (e.g. notificationService not configured)
    });
    const notifier = makeNotifier();
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

    await supervisor.run();

    assert.equal(kv._store[KV_KEYS.SERVICE.SLEEPING("ronaldo")], undefined, "SLEEPING flag should be cleared even without health key");
    assert.deepEqual(JSON.parse(kv._store[KV_KEYS.CLUSTER.SLEEPING_SERVICES("c1")]), []);
    assert.ok(notifier._calls.includes("c1"));
  });

  for (const nonReadyHealth of ["unhealthy", "starting"] as const) {
    it(`does NOT clear SLEEPING flag when service health is "${nonReadyHealth}"`, async () => {
      const cluster: FakeCluster = { id: "c1", name: "C1" };
      const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
      const service: FakeService = { id: "s1", name: "ronaldo", type: "web", clusterId: "c1" };

      const db = makeDb([cluster], [service], [instance]);
      const kv = makeKv({
        nodeWorkloads: { "node-1": [{ name: "ronaldo", type: "web" }] },
        sleepingFlags: { "ronaldo": "1" },
        clusterSleepingSet: { "c1": JSON.stringify(["ronaldo"]) },
        healthFlags: { "ronaldo": nonReadyHealth },
      });
      const notifier = makeNotifier();
      const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

      await supervisor.run();

      assert.equal(kv._store[KV_KEYS.SERVICE.SLEEPING("ronaldo")], "1", `SLEEPING flag must stay when health is "${nonReadyHealth}"`);
    });
  }

  it("keeps non-sleeping services out of the cluster sleeping set", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const services: FakeService[] = [
      { id: "s1", name: "api", type: "web", clusterId: "c1" },
      { id: "s2", name: "worker", type: "worker", clusterId: "c1" },
    ];

    const db = makeDb([cluster], services, [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "api", type: "web" }, { name: "worker", type: "worker" }] },
      // no sleeping flags set
    });
    const notifier = makeNotifier();
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

    await supervisor.run();

    const stored = kv._store[KV_KEYS.CLUSTER.SLEEPING_SERVICES("c1")];
    assert.deepEqual(JSON.parse(stored), []);
    assert.equal(notifier._calls.length, 0);
  });

  it("handles multiple services where only some are sleeping", async () => {
    const cluster: FakeCluster = { id: "c1", name: "C1" };
    const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1" };
    const services: FakeService[] = [
      { id: "s1", name: "api", type: "web", clusterId: "c1" },
      { id: "s2", name: "worker", type: "worker", clusterId: "c1" },
    ];

    const db = makeDb([cluster], services, [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "api", type: "web" }] },  // api running, worker stopped
      sleepingFlags: { "worker": "1" },
    });
    const notifier = makeNotifier();
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, notifier);

    await supervisor.run();

    const stored = kv._store[KV_KEYS.CLUSTER.SLEEPING_SERVICES("c1")];
    assert.deepEqual(JSON.parse(stored), ["worker"]);
  });
});

describe("WorkloadSupervisor — reconcileTraefikRoutes skips sleeping services", () => {
  const cluster: FakeCluster = { id: "c1", name: "C1" };
  const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1", address: "10.0.0.1" };
  const service: FakeService = { id: "s1", name: "api", type: "web", clusterId: "c1" };

  function makeTraefik(registerRouteCalls: string[], currentUrl: string | null = null) {
    return {
      getRouteBackendUrl: async () => currentUrl,
      registerRoute: async ({ serviceName }: { serviceName: string }) => { registerRouteCalls.push(serviceName); },
      setLoadingMode: async () => {},
    } as any;
  }

  it("does NOT call registerRoute when service is running but explicitly unhealthy", async () => {
    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "api", type: "web", host_port: 62000 }] },
      sleepingFlags: { "api": "1" },
      healthFlags: { "api": "unhealthy" },
    });
    const registerRouteCalls: string[] = [];
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier(), makeTraefik(registerRouteCalls, "http://127.0.0.1:19503"));

    await supervisor.run();

    assert.equal(registerRouteCalls.length, 0, "registerRoute must not be called when service is unhealthy");
  });

  it("calls registerRoute when service woke up (SLEEPING set, running, health absent)", async () => {
    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "api", type: "web", host_port: 62000 }] },
      sleepingFlags: { "api": "1" },
      // no healthFlags — health key never written
    });
    const registerRouteCalls: string[] = [];
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier(), makeTraefik(registerRouteCalls, "http://127.0.0.1:19503"));

    await supervisor.run();

    assert.ok(registerRouteCalls.includes("api"), "registerRoute should fire once service woke up and health is unknown");
  });

  it("calls registerRoute when service is not sleeping and URL differs", async () => {
    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [{ name: "api", type: "web", host_port: 62000 }] },
    });
    const registerRouteCalls: string[] = [];
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier(), makeTraefik(registerRouteCalls));

    await supervisor.run();

    assert.ok(registerRouteCalls.includes("api"), "registerRoute should be called when URL differs and service is not sleeping");
  });
});

describe("WorkloadSupervisor — reconcileSleepingSet sets loading mode", () => {
  const cluster: FakeCluster = { id: "c1", name: "C1" };
  const instance: FakeInstance = { id: "i1", tag: "node-1", kind: "dedicated", clusterId: "c1", address: "10.0.0.1" };
  const service: FakeService = { id: "s1", name: "api", type: "web", clusterId: "c1" };

  function makeTraefik(setLoadingModeCalls: string[], backendUrls: Record<string, string | null> = {}) {
    return {
      getRouteBackendUrl: async (name: string) => backendUrls[name] ?? null,
      registerRoute: async () => {},
      setLoadingMode: async (name: string) => { setLoadingModeCalls.push(name); },
    } as any;
  }

  it("calls setLoadingMode when sleeping service points to real backend", async () => {
    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [] },
      sleepingFlags: { "api": "1" },
    });
    const setLoadingModeCalls: string[] = [];
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier(), makeTraefik(setLoadingModeCalls, { "api": "http://10.0.0.1:62000" }));

    await supervisor.run();

    assert.ok(setLoadingModeCalls.includes("api"), "setLoadingMode should be called when sleeping service still points to real backend");
  });

  it("does NOT call setLoadingMode when route already points to stub address", async () => {
    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [] },
      sleepingFlags: { "api": "1" },
    });
    const setLoadingModeCalls: string[] = [];
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier(), makeTraefik(setLoadingModeCalls, { "api": SERVICE_STUB_ADDRESS }));

    await supervisor.run();

    assert.equal(setLoadingModeCalls.length, 0, "setLoadingMode should NOT be called when route already points to stub (idempotent)");
  });

  it("does NOT call setLoadingMode when no route is registered", async () => {
    const db = makeDb([cluster], [service], [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [] },
      sleepingFlags: { "api": "1" },
    });
    const setLoadingModeCalls: string[] = [];
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier(), makeTraefik(setLoadingModeCalls, { "api": null }));

    await supervisor.run();

    assert.equal(setLoadingModeCalls.length, 0, "setLoadingMode should NOT be called when no route exists yet");
  });

  it("calls setLoadingMode for each sleeping service pointing to real backend", async () => {
    const services: FakeService[] = [
      { id: "s1", name: "api", type: "web", clusterId: "c1" },
      { id: "s2", name: "worker", type: "worker", clusterId: "c1" },
    ];
    const db = makeDb([cluster], services, [instance]);
    const kv = makeKv({
      nodeWorkloads: { "node-1": [] },
      sleepingFlags: { "api": "1", "worker": "1" },
    });
    const setLoadingModeCalls: string[] = [];
    const supervisor = new WorkloadSupervisor(db, kv, makeConnectionManager(["node-1"]), noopJwt, makeNotifier(), makeTraefik(setLoadingModeCalls, { "api": "http://10.0.0.1:62000", "worker": "http://10.0.0.1:62001" }));

    await supervisor.run();

    assert.deepEqual(setLoadingModeCalls.sort(), ["api", "worker"], "setLoadingMode should be called for every sleeping service with a real backend URL");
  });
});
