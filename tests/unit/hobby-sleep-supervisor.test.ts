// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

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
  } as any;
}

const noopJwt = { createReprovisionToken: async () => "tok", createNodeAccessToken: async () => "tok" } as any;
const noopNotifier = { notifyRefresh: () => {}, broadcast: async () => {} } as any;

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
