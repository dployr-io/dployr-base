// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string | null; role?: string };
type FakeDeployment = { id: string; clusterId: string; name: string; userId: string; type: string; source: string; runtimeType?: string };
type FakeService = { id: string; name: string; type: string; clusterId: string; deploymentId?: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string | null };

function makeDb({
  instances = [] as FakeInstance[],
  deployments = [] as FakeDeployment[],
  clusters = [] as FakeCluster[],
  services = [] as FakeService[],
  upsertedServices = [] as any[],
  withSecrets = true,
}) {
  return {
    instances: {
      find: async (filter: any) => {
        if (filter.id) return instances.find((i) => i.id === filter.id) ?? null;
        if (filter.tag) return instances.find((i) => i.tag === filter.tag) ?? null;
        if (filter.clusterId && filter.kind)
          return instances.find((i) => i.clusterId === filter.clusterId && i.kind === filter.kind) ?? null;
        if (filter.role) return instances.find((i) => i.role === filter.role) ?? null;
        return null;
      },
      list: async (filter: any) => {
        let result = instances;
        if (filter?.role) result = result.filter((i) => i.role === filter.role);
        return { instances: result, total: result.length };
      },
    },
    deployments: {
      list: async (filter: any) => ({
        deployments: filter.clusterId ? deployments.filter((d) => d.clusterId === filter.clusterId) : deployments,
      }),
    },
    clusters: {
      list: async () => ({ clusters }),
    },
    services: {
      list: async (filter: any) => ({ services: services.filter((s) => s.clusterId === filter.clusterId) }),
      upsert: async (data: any) => {
        upsertedServices.push(data);
      },
    },
    serviceSecrets: withSecrets ? { getDecrypted: async () => ({ values: {}, missing: [] }) } : null,
    billing: {
      getEffectivePlan: async () => "hobby",
    },
  } as any;
}

function makeKv({
  workloadsByNodeTag = {} as Record<string, { services?: any[]; deployments?: any[] }>,
  inFlightBuilds = {} as Record<string, any[]>,
}: {
  workloadsByNodeTag?: Record<string, { services?: any[]; deployments?: any[] }>;
  inFlightBuilds?: Record<string, any[]>;
}) {
  return {
    entities: {
      getEntity: async (key: string) => {
        for (const [tag, data] of Object.entries(workloadsByNodeTag)) {
          if (key === KV_KEYS.INSTANCE.ENTITY(tag, "workloads")) {
            return { data, version: 1 };
          }
        }
        return null;
      },
    },
    instanceCache: {
      getInFlightBuilds: async (nodeTag: string) => inFlightBuilds[nodeTag] ?? [],
      trackInFlightBuild: async () => {},
      getBuildSlots: async () => 0,
      incrementBuildSlots: async () => {},
    },
    payloads: {
      saveBuildCallback: async () => {},
      saveDeploymentPayload: async () => {},
      enqueueBuild: async () => {},
    },
    kv: {
      get: async (_key: string) => null,
      put: async (_key: string, _value: string) => {},
      delete: async (_key: string) => {},
    },
  } as any;
}

describe("WorkloadSupervisor — dedicated instance reprovisioning", () => {
  it("reprovisionsservice on dedicated instance when it is missing from workloads (source=image)", async () => {
    const dedicatedTag = "dedicated-1";
    const cluster: FakeCluster = { id: "cluster-a", name: "Cluster A", poolInstanceId: null };
    const dedicatedInstance: FakeInstance = { id: "inst-ded-1", tag: dedicatedTag, kind: "dedicated", clusterId: "cluster-a" };
    const deployment: FakeDeployment = { id: "dep-1", clusterId: "cluster-a", name: "api", userId: "u1", type: "web", source: "image" };
    const service: FakeService = { id: "svc-1", name: "api", type: "web", clusterId: "cluster-a", deploymentId: "dep-1" };

    const sentTasks: Array<{ tag: string; task: any }> = [];
    const db = makeDb({ instances: [dedicatedInstance], deployments: [deployment], clusters: [cluster], services: [service] });
    const kv = makeKv({ workloadsByNodeTag: { [dedicatedTag]: { services: [], deployments: [] } } });
    const connManager = {
      hasNodeConnection: (tag: string) => tag === dedicatedTag,
      sendTask: (tag: string, task: any) => { sentTasks.push({ tag, task }); return true; },
      getNodeConnectionsByClusterId: (_id: string) => [],
    } as any;
    const jwtService = { createNodeAccessToken: async () => "fake-token" } as any;
    const notifier = { notifyRefresh: () => {} } as any;

    const supervisor = new WorkloadSupervisor(db, kv, connManager, jwtService, notifier);
    await supervisor.run();

    assert.ok(sentTasks.length > 0, "expected a reprovision task to be sent");
    assert.equal(sentTasks[0].tag, dedicatedTag, "task should be routed to the dedicated instance");
    assert.equal(sentTasks[0].task.Type, "deployments:post", "task should be a deploy task");
  });

  it("in-flight build on a different cluster does not block reprovisioning the same-named service on a dedicated instance", async () => {
    const dedicatedTag = "dedicated-b";
    const buildNodeTag = "build-1";

    const clusterB: FakeCluster = { id: "cluster-b", name: "Cluster B", poolInstanceId: null };
    const dedicatedInstance: FakeInstance = { id: "inst-b", tag: dedicatedTag, kind: "dedicated", clusterId: "cluster-b" };
    const buildNode: FakeInstance = { id: "build-inst-1", tag: buildNodeTag, kind: "pool", role: "build" };

    const deployment: FakeDeployment = { id: "dep-b", clusterId: "cluster-b", name: "api", userId: "u2", type: "web", source: "remote" };
    const service: FakeService = { id: "svc-b", name: "api", type: "web", clusterId: "cluster-b", deploymentId: "dep-b" };

    // Cluster A (different cluster) has an in-flight build for service also named "api"
    const clusterAInFlightBuild = { taskId: "task-a", clusterId: "cluster-a", payload: { name: "api" } };

    const db = makeDb({ instances: [dedicatedInstance, buildNode], deployments: [deployment], clusters: [clusterB], services: [service] });
    const kv = makeKv({
      workloadsByNodeTag: { [dedicatedTag]: { services: [], deployments: [] } },
      inFlightBuilds: { [buildNodeTag]: [clusterAInFlightBuild] },
    });
    const connManager = {
      hasNodeConnection: (tag: string) => [dedicatedTag, buildNodeTag].includes(tag),
      sendTask: (_tag: string, _task: any) => true,
      subscribeToNodeLogs: async () => {},
      getNodeConnectionsByClusterId: (_id: string) => [],
    } as any;
    const jwtService = { createNodeAccessToken: async () => "fake-token" } as any;
    const notifier = { notifyRefresh: () => {} } as any;

    const supervisor = new WorkloadSupervisor(db, kv, connManager, jwtService, notifier);
    await supervisor.run();

    const summary = supervisor.getRunSummary() as { clusters: Array<{ clusterName: string; reprovisioned: string[] }> };
    const clusterBResult = summary.clusters.find((c) => c.clusterName === "Cluster B");
    assert.ok(clusterBResult, "cluster B should appear in run summary");
    assert.ok(
      clusterBResult!.reprovisioned.includes("api"),
      "api should be reprovisioned on cluster B — in-flight build on cluster A must not block it",
    );
  });

  it("in-flight build on the SAME cluster still blocks reprovisioning", async () => {
    const dedicatedTag = "dedicated-c";
    const buildNodeTag = "build-1";

    const cluster: FakeCluster = { id: "cluster-c", name: "Cluster C", poolInstanceId: null };
    const dedicatedInstance: FakeInstance = { id: "inst-c", tag: dedicatedTag, kind: "dedicated", clusterId: "cluster-c" };
    const buildNode: FakeInstance = { id: "build-inst-1", tag: buildNodeTag, kind: "pool", role: "build" };

    const deployment: FakeDeployment = { id: "dep-c", clusterId: "cluster-c", name: "api", userId: "u3", type: "web", source: "remote" };
    const service: FakeService = { id: "svc-c", name: "api", type: "web", clusterId: "cluster-c", deploymentId: "dep-c" };

    // Same cluster already has an in-flight build for "api" — should NOT re-trigger
    const sameClusterInFlightBuild = { taskId: "task-c", clusterId: "cluster-c", payload: { name: "api" } };

    const db = makeDb({ instances: [dedicatedInstance, buildNode], deployments: [deployment], clusters: [cluster], services: [service] });
    const kv = makeKv({
      workloadsByNodeTag: { [dedicatedTag]: { services: [], deployments: [] } },
      inFlightBuilds: { [buildNodeTag]: [sameClusterInFlightBuild] },
    });
    const connManager = {
      hasNodeConnection: (tag: string) => [dedicatedTag, buildNodeTag].includes(tag),
      sendTask: () => true,
      getNodeConnectionsByClusterId: (_id: string) => [],
    } as any;
    const jwtService = { createNodeAccessToken: async () => "fake-token" } as any;
    const notifier = { notifyRefresh: () => {} } as any;

    const supervisor = new WorkloadSupervisor(db, kv, connManager, jwtService, notifier);
    await supervisor.run();

    const summary = supervisor.getRunSummary() as { clusters: Array<{ clusterName: string; reprovisioned: string[] }> };
    const clusterResult = summary.clusters.find((c) => c.clusterName === "Cluster C");
    assert.ok(clusterResult, "cluster C should appear in run summary");
    assert.ok(
      !clusterResult!.reprovisioned.includes("api"),
      "api should NOT be reprovisioned — same-cluster in-flight build should block it",
    );
  });
});
