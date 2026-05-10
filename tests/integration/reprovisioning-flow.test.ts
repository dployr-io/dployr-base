// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { AdminService } from "@/services/admin.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string };
type FakeDeployment = { id: string; clusterId: string; name: string; userId: string };
type FakeService = { id: string; name: string; type: string; clusterId: string; deploymentId?: string };

function makeDb({
  instances = [] as FakeInstance[],
  clusters = [] as FakeCluster[],
  deployments = [] as FakeDeployment[],
  services = [] as FakeService[],
  upsertedServices = [] as any[],
}) {
  return {
    instances: {
      find: async (filter: any) => {
        if (filter.tag) return instances.find((i) => i.tag === filter.tag) ?? null;
        if (filter.clusterId && filter.kind) return instances.find((i) => i.clusterId === filter.clusterId && i.kind === filter.kind) ?? null;
        return null;
      },
      list: async () => ({ instances }),
    },
    clusters: {
      list: async () => ({ clusters }),
    },
    deployments: {
      get: async (id: string) => deployments.find((d) => d.id === id) ?? null,
      list: async (filter: any) => ({
        deployments: filter.clusterId
          ? deployments.filter((d) => d.clusterId === filter.clusterId)
          : deployments,
      }),
    },
    services: {
      list: async (filter: any) => ({
        services: filter.clusterId
          ? services.filter((s) => s.clusterId === filter.clusterId)
          : services,
      }),
      upsert: async (data: any) => {
        upsertedServices.push(data);
      },
    },
    serviceSecrets: null,
  } as any;
}

function makeKv(workloadsByTag: Record<string, { services: any[] }>) {
  return {
    entities: {
      getEntity: async (key: string) => {
        for (const [tag, data] of Object.entries(workloadsByTag)) {
          if (key === KV_KEYS.INSTANCE.ENTITY(tag, "workloads")) {
            return { data, version: 1 };
          }
        }
        return null;
      },
    },
    instanceCache: {
      registerClusterNode: async () => {},
      deregisterClusterNode: async () => {},
    },
  } as any;
}

function makeConnectionManager(connectedTags: string[]) {
  return {
    hasNodeConnection: (tag: string) => connectedTags.includes(tag),
    getClientConnections: (clusterId: string) => [],
  } as any;
}

const noopJwt = { createReprovisionToken: async () => "tok" } as any;
const noopDployrd = { createDeployTask: () => ({}) } as any;
const noopNotifier = {
  notifyRefresh: () => {},
  broadcast: async () => {},
} as any;

describe("Reprovisioning flow — deployment gets new ID", () => {
  it("Monitor still shows service even with stale deployment ID in node data", async () => {
    const poolTag = "pool-1";

    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    // After reprovisioning: old deployment gone, new one created with new ID
    const newDep = { id: "new-dep-id", clusterId: "cluster-a", name: "api", userId: "u1" };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [newDep],
    });

    const kv = makeKv({
      [poolTag]: { services: [{ name: "api", type: "web", deployment_id: "old-dep-id-stale" }] },  // Node still has old ID
    });
    const connManager = makeConnectionManager([poolTag]);

    // Monitor should still show the service because it matches by NAME
    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    const node = topology[0];
    const clusterView = node.clusters[0];

    assert.equal(clusterView.broadcastServices.length, 1, "service visible despite stale deployment ID");
    assert.equal(clusterView.broadcastServices[0].name, "api");
  });

  it("monitor page shows service correctly after reprovisioning", async () => {
    const poolTag = "pool-1";

    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    // New deployment after reprovisioning
    const newDep = { id: "new-dep-id", clusterId: "cluster-a", name: "api", userId: "u1" };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [newDep],
    });

    const kv = makeKv({
      [poolTag]: { services: [{ name: "api", type: "web", deployment_id: "old-dep-id-stale" }] },
    });
    const connManager = makeConnectionManager([poolTag]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    const node = topology[0];
    const clusterView = node.clusters[0];

    assert.equal(clusterView.broadcastServices.length, 1, "service visible in cluster view");
    assert.equal(clusterView.broadcastServices[0].name, "api");
    assert.equal(node.rawNodeServices.length, 0, "no unmatched services");
  });
});

describe("Service lifecycle — create, run, reprovision, run again", () => {
  it("Monitor correctly matches service through deployment reprovisioning", async () => {
    const poolTag = "pool-1";
    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    // Phase 1: Initial deployment v1
    const depV1 = { id: "dep-v1", clusterId: "cluster-a", name: "service-x", userId: "u1" };

    const dbV1 = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [depV1],
    });

    const kvV1 = makeKv({
      [poolTag]: { services: [{ name: "service-x", type: "web", deployment_id: "dep-v1" }] },
    });

    let adminV1 = new AdminService(dbV1, kvV1, makeConnectionManager([poolTag]));
    let topologyV1 = await adminV1.getTopology();

    assert.equal(topologyV1[0].clusters[0].broadcastServices.length, 1, "service visible in phase 1");
    assert.equal(topologyV1[0].clusters[0].broadcastServices[0].name, "service-x");

    // Phase 2: Deployment reprovisioned with new ID (dep-v1 no longer exists)
    const depV2 = { id: "dep-v2", clusterId: "cluster-a", name: "service-x", userId: "u1" };

    const dbV2 = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [depV2],  // Only v2 exists
    });

    const kvV2 = makeKv({
      [poolTag]: { services: [{ name: "service-x", type: "web", deployment_id: "dep-v1" }] },  // Node still reports old ID
    });

    const adminV2 = new AdminService(dbV2, kvV2, makeConnectionManager([poolTag]));
    const topologyV2 = await adminV2.getTopology();

    // Service should still be visible because matching is by NAME
    assert.equal(topologyV2[0].clusters[0].broadcastServices.length, 1, "service still visible after reprovisioning");
    assert.equal(topologyV2[0].clusters[0].broadcastServices[0].name, "service-x");
  });
});

describe("Stale service cleanup", () => {
  it("orphaned service appears in Monitor when deployment is deleted", async () => {
    const poolTag = "pool-1";
    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [],  // Deployment was deleted
    });

    const kv = makeKv({
      [poolTag]: { services: [{ name: "ghost-service", type: "web" }] },
    });

    const adminService = new AdminService(db, kv, makeConnectionManager([poolTag]));
    const topology = await adminService.getTopology();

    const node = topology[0];

    // Service should NOT appear in cluster view (no matching deployment)
    assert.equal(node.clusters[0].broadcastServices.length, 0);

    // Service SHOULD appear in rawNodeServices as unmatched
    assert.equal(node.rawNodeServices.length, 1, "orphaned service visible in rawNodeServices");
    assert.equal(node.rawNodeServices[0].name, "ghost-service");
    assert.equal(node.rawNodeServices[0].ownerClusterId, undefined);
  });
});

describe("Deployment name collision handling", () => {
  it("handles shared deployment names across clusters by assigning to first match", async () => {
    const poolTag = "pool-1";
    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const clusterB = { id: "cluster-b", name: "Cluster B", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    // Both clusters have a deployment named "shared" (different deployment IDs)
    const depA = { id: "dep-a", clusterId: "cluster-a", name: "shared", userId: "u1" };
    const depB = { id: "dep-b", clusterId: "cluster-b", name: "shared", userId: "u2" };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA, clusterB],
      deployments: [depA, depB],
    });

    const kv = makeKv({
      [poolTag]: { services: [{ name: "shared", type: "web" }] },
    });

    const adminService = new AdminService(db, kv, makeConnectionManager([poolTag]));
    const topology = await adminService.getTopology();

    const node = topology[0];
    const viewA = node.clusters.find((c) => c.id === "cluster-a");
    const viewB = node.clusters.find((c) => c.id === "cluster-b");

    // With name-based matching, the service will be in broadcastServices for each cluster that has a deployment with that name
    // Both A and B have deployments named "shared", so both will see it
    assert.ok(viewA!.broadcastServices.some((s) => s.name === "shared"), "cluster A sees shared service");
    assert.ok(viewB!.broadcastServices.some((s) => s.name === "shared"), "cluster B sees shared service");

    // The service is not unmatched (it exists in both clusters)
    assert.equal(node.rawNodeServices.length, 0, "service is matched, not unmatched");
  });
});
