// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { hobbySleepSupervisor } from "@/services/background/jobs/hobby-sleep-supervisor.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { MS_12_MINUTES } from "@/lib/constants/duration.js";

type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string; address?: string };
type FakeService = { id: string; name: string; type: string; clusterId: string; deploymentId?: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string };

type FakeDeployment = { id: string; clusterId: string; name: string; userId: string; port?: number; source?: string; type?: string; image?: string };

function makeDb({
  instances = [] as FakeInstance[],
  services = [] as FakeService[],
  clusters = [] as FakeCluster[],
  deployments = [] as FakeDeployment[],
  withSecrets = false,
}) {
  return {
    instances: {
      find: async (filter: any) => {
        if (filter.id) return instances.find((i) => i.id === filter.id) ?? null;
        if (filter.tag) return instances.find((i) => i.tag === filter.tag) ?? null;
        if (filter.clusterId && filter.kind) return instances.find((i) => i.clusterId === filter.clusterId && i.kind === filter.kind) ?? null;
        return null;
      },
    },
    deployments: {
      list: async (filter: any) => ({
        deployments: filter?.clusterId
          ? deployments.filter((d) => d.clusterId === filter.clusterId)
          : deployments,
      }),
      updateBuildResult: async () => {},
    },
    clusters: {
      list: async () => ({ clusters }),
    },
    services: {
      list: async (filter: any) => ({ services: services.filter((s) => s.clusterId === filter.clusterId) }),
      upsert: async () => {},
    },
    serviceSecrets: withSecrets ? { list: async () => [] } : null,
    serviceEnvs: { list: async () => [] },
  } as any;
}

function makeKv(workloadsByTag: Record<string, any[]>, sleepingServices: string[] = []) {
  return {
    entities: {
      getEntity: async (key: string) => {
        for (const [tag, svcs] of Object.entries(workloadsByTag)) {
          if (key === KV_KEYS.INSTANCE.ENTITY(tag, "workloads")) {
            return { data: { services: svcs }, version: 1 };
          }
        }
        return null;
      },
    },
    instanceCache: {
      registerClusterNode: async () => {},
      deregisterClusterNode: async () => {},
    },
    kv: {
      get: async (key: string) => {
        for (const name of sleepingServices) {
          if (key === KV_KEYS.SERVICE.SLEEPING(name)) return "1";
        }
        return null;
      },
      put: async () => {},
    },
  } as any;
}

function makeConnectionManager(connectedTags: string[]) {
  return {
    hasNodeConnection: (tag: string) => connectedTags.includes(tag),
    sendTask: () => false,
    getNodeConnectionsByClusterId: (_id: string) => [],
  } as any;
}

const noopJwt = { createReprovisionToken: async () => "tok", createNodeAccessToken: async () => "tok" } as any;
const noopNotifier = { notifyRefresh: () => {}, broadcast: async () => {} } as any;


type JobService = { id: string; name: string; clusterId: string; createdAt: number };

function makeJobCtx({
  services = [] as JobService[],
  plan = "hobby",
  routingKey = "node-1" as string | null,
  sleepingNames = [] as string[],
  lastActiveMs = null as number | null,
  sendTaskResult = true,
}) {
  const kvStore: Record<string, string> = {};

  const db = {
    services: { list: async () => ({ services }) },
    billing: { getEffectivePlan: async (_clusterId: string) => plan },
    instances: { getRoutingKey: async (_clusterId: string) => routingKey },
  } as any;

  const kv = {
    kv: {
      get: async (key: string) => {
        for (const name of sleepingNames) {
          if (key === KV_KEYS.SERVICE.SLEEPING(name)) return "1";
        }
        for (const svc of services) {
          if (key === KV_KEYS.SERVICE.LAST_ACTIVE(svc.name) && lastActiveMs !== null) {
            return String(lastActiveMs);
          }
        }
        return null;
      },
      put: async (key: string, value: string) => { kvStore[key] = value; },
    },
  } as any;

  const tasksSent: { routingKey: string; task: any }[] = [];
  const adapters = {
    ws: {
      connectionManager: {
        sendTask: (rk: string, task: any) => { tasksSent.push({ routingKey: rk, task }); return sendTaskResult; },
      },
    },
    config: { server: { base_url: "https://base.test" } },
  } as any;

  const jwt = { createNodeAccessToken: async () => "tok" } as any;

  return { db, kv, adapters, jwt, tasksSent, kvStore };
}

describe("hobbySleepSupervisor — inactivity sleep", () => {
  it("does nothing when no services exist", async () => {
    const { db, kv, adapters, jwt, tasksSent } = makeJobCtx({ services: [] });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(tasksSent.length, 0);
  });

  it("skips non-hobby tier services", async () => {
    const svc: JobService = { id: "s1", name: "ronaldo", clusterId: "c1", createdAt: Date.now() - MS_12_MINUTES - 1000 };
    const { db, kv, adapters, jwt, tasksSent } = makeJobCtx({ services: [svc], plan: "pro" });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(tasksSent.length, 0);
  });

  it("skips a service that already has SLEEPING flag", async () => {
    const svc: JobService = { id: "s1", name: "ronaldo", clusterId: "c1", createdAt: Date.now() - MS_12_MINUTES - 1000 };
    const { db, kv, adapters, jwt, tasksSent } = makeJobCtx({ services: [svc], sleepingNames: ["ronaldo"] });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(tasksSent.length, 0);
  });

  it("skips a service active within the last 12 minutes", async () => {
    const svc: JobService = { id: "s1", name: "ronaldo", clusterId: "c1", createdAt: Date.now() - MS_12_MINUTES - 1000 };
    const recentlyActive = Date.now() - (MS_12_MINUTES - 60_000); // 11 min ago
    const { db, kv, adapters, jwt, tasksSent } = makeJobCtx({ services: [svc], lastActiveMs: recentlyActive });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(tasksSent.length, 0);
  });

  it("sleeps a service inactive for more than 12 minutes", async () => {
    const svc: JobService = { id: "s1", name: "ronaldo", clusterId: "c1", createdAt: Date.now() - MS_12_MINUTES - 1000 };
    const staleActive = Date.now() - (MS_12_MINUTES + 60_000); // 13 min ago
    const { db, kv, adapters, jwt, tasksSent, kvStore } = makeJobCtx({ services: [svc], lastActiveMs: staleActive });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(tasksSent.length, 1);
    assert.equal(tasksSent[0].routingKey, "node-1");
    assert.equal(tasksSent[0].task.Type, "services/sleep?name=ronaldo:post");
    assert.equal(kvStore[KV_KEYS.SERVICE.SLEEPING("ronaldo")], "1", "SLEEPING flag should be set");
  });

  it("uses createdAt as fallback when LAST_ACTIVE is not set", async () => {
    const createdAt = Date.now() - (MS_12_MINUTES + 60_000); // 13 min ago
    const svc: JobService = { id: "s1", name: "ronaldo", clusterId: "c1", createdAt };
    const { db, kv, adapters, jwt, tasksSent } = makeJobCtx({ services: [svc], lastActiveMs: null });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(tasksSent.length, 1, "should sleep when createdAt is beyond threshold");
  });

  it("does not set SLEEPING flag when sendTask returns false (no connection)", async () => {
    const svc: JobService = { id: "s1", name: "ronaldo", clusterId: "c1", createdAt: Date.now() - MS_12_MINUTES - 1000 };
    const staleActive = Date.now() - (MS_12_MINUTES + 60_000);
    const { db, kv, adapters, jwt, kvStore } = makeJobCtx({ services: [svc], lastActiveMs: staleActive, sendTaskResult: false });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(kvStore[KV_KEYS.SERVICE.SLEEPING("ronaldo")], undefined, "should not set SLEEPING if task was not delivered");
  });

  it("skips sleep when no routing key found for cluster", async () => {
    const svc: JobService = { id: "s1", name: "ronaldo", clusterId: "c1", createdAt: Date.now() - MS_12_MINUTES - 1000 };
    const staleActive = Date.now() - (MS_12_MINUTES + 60_000);
    const { db, kv, adapters, jwt, tasksSent } = makeJobCtx({ services: [svc], lastActiveMs: staleActive, routingKey: null });
    await hobbySleepSupervisor({ db, kv, adapters, jwt } as any);
    assert.equal(tasksSent.length, 0);
  });
});


describe("WorkloadSupervisor — hobby sleep guard", () => {
  it("skips reprovision for a service with SLEEPING flag set", async () => {
    const poolTag = "pool-1";
    const cluster: FakeCluster = { id: "cluster-a", name: "A", poolInstanceId: "inst-1" };
    const instance: FakeInstance = { id: "inst-1", tag: poolTag, kind: "pool" };

    // Service exists in DB but NOT in node workloads (container stopped — sleeping)
    const service: FakeService = { id: "svc-1", name: "payper", type: "web", clusterId: "cluster-a" };

    const db = makeDb({ instances: [instance], services: [service], clusters: [cluster] });
    // Node reports empty workloads — payper container is stopped
    const kv = makeKv({ [poolTag]: [] }, ["payper"]);
    const connManager = makeConnectionManager([poolTag]);

    const tasksSent: any[] = [];
    connManager.sendTask = (key: string, task: any) => { tasksSent.push({ key, task }); return true; };

    const supervisor = new WorkloadSupervisor(db, kv, connManager, noopJwt, noopNotifier);
    await supervisor.run();

    assert.equal(tasksSent.length, 0, "should not send reprovision task for sleeping service");
  });

  it("reprovisiones a service that is NOT sleeping even when container is stopped", async () => {
    const poolTag = "pool-1";
    const cluster: FakeCluster = { id: "cluster-a", name: "A", poolInstanceId: "inst-1" };
    const instance: FakeInstance = { id: "inst-1", tag: poolTag, kind: "pool", address: "10.0.0.1" };
    const service: FakeService = { id: "svc-1", name: "payper", type: "web", clusterId: "cluster-a" };
    const deployment: FakeDeployment = { id: "dep-1", clusterId: "cluster-a", name: "payper", userId: "u1", source: "image", type: "web", image: "reg/payper:latest" };

    const db = makeDb({ instances: [instance], services: [service], clusters: [cluster], deployments: [deployment], withSecrets: true });
    // Node reports empty workloads, no SLEEPING flag
    const kv = makeKv({ [poolTag]: [] }, []);
    const connManager = makeConnectionManager([poolTag]);

    const tasksSent: any[] = [];
    connManager.sendTask = (_key: string, task: any) => { tasksSent.push(task); return true; };

    const supervisor = new WorkloadSupervisor(db, kv, connManager, noopJwt, noopNotifier);
    await supervisor.run();

    assert.ok(tasksSent.length > 0, "should attempt reprovision when service is missing and not sleeping");
  });
});
