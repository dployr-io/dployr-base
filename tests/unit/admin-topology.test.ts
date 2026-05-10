// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdminService } from "@/services/admin.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string };
type FakeDeployment = { id: string; clusterId: string; name: string };
type FakeService = { id: string; name: string; type: string; clusterId: string };

function makeDb({
  instances = [] as FakeInstance[],
  clusters = [] as FakeCluster[],
  deployments = [] as FakeDeployment[],
  services = [] as FakeService[],
}) {
  return {
    instances: {
      list: async () => ({ instances }),
    },
    clusters: {
      list: async () => ({ clusters }),
    },
    deployments: {
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
    },
  } as any;
}

function makeKv(workloads: Record<string, { services: any[] }>) {
  return {
    entities: {
      getEntity: async (key: string) => {
        for (const [tag, data] of Object.entries(workloads)) {
          if (key === KV_KEYS.INSTANCE.ENTITY(tag, "workloads")) {
            return { data, version: 1 };
          }
        }
        return null;
      },
    },
  } as any;
}

function makeConnectionManager(connectedTags: string[]) {
  return {
    hasNodeConnection: (tag: string) => connectedTags.includes(tag),
    getClientConnections: (clusterId: string) => [],
  } as any;
}

describe("AdminService.getTopology — Monitor page isolation", () => {
  it("does not show cluster A's services in cluster B's broadcastServices", async () => {
    const poolTag = "pool-1";

    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const clusterB = { id: "cluster-b", name: "Cluster B", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    const depA = { id: "dep-a", clusterId: "cluster-a", name: "app-a" };
    const depB = { id: "dep-b", clusterId: "cluster-b", name: "app-b" };

    const nodeWorkloads = {
      services: [
        { name: "app-a", type: "web" },
        { name: "app-b", type: "web" },
      ],
    };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA, clusterB],
      deployments: [depA, depB],
    });
    const kv = makeKv({ [poolTag]: nodeWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    assert.equal(topology.length, 1, "one node in topology");
    const node = topology[0];
    assert.equal(node.clusters.length, 2, "node has two clusters");

    const clusterAView = node.clusters.find((c) => c.id === "cluster-a");
    const clusterBView = node.clusters.find((c) => c.id === "cluster-b");

    assert.ok(clusterAView, "cluster A view exists");
    assert.ok(clusterBView, "cluster B view exists");

    assert.equal(clusterAView!.broadcastServices.length, 1, "cluster A sees 1 service");
    assert.equal(clusterAView!.broadcastServices[0].name, "app-a");

    assert.equal(clusterBView!.broadcastServices.length, 1, "cluster B sees 1 service");
    assert.equal(clusterBView!.broadcastServices[0].name, "app-b");
  });

  it("shows unmatched services in rawNodeServices only", async () => {
    const poolTag = "pool-1";

    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    const depA = { id: "dep-a", clusterId: "cluster-a", name: "app-a" };

    const nodeWorkloads = {
      services: [
        { name: "app-a", type: "web" },      // Matches deployment
        { name: "orphaned", type: "web" },   // No matching deployment
      ],
    };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [depA],
    });
    const kv = makeKv({ [poolTag]: nodeWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    const node = topology[0];

    assert.equal(node.rawNodeServices.length, 1, "one unmatched service in rawNodeServices");
    assert.equal(node.rawNodeServices[0].name, "orphaned");
    assert.equal(node.rawNodeServices[0].ownerClusterId, undefined, "unmatched service has no owner");
  });

  it("handles dedicated nodes (no cross-cluster contamination)", async () => {
    const dedicatedTag = "dedicated-1";

    const clusterA = { id: "cluster-a", name: "Cluster A" };
    const clusterB = { id: "cluster-b", name: "Cluster B" };
    const dedicatedInstA = { id: "ded-a", tag: dedicatedTag, kind: "dedicated" as const, clusterId: "cluster-a" };
    const dedicatedInstB = { id: "ded-b", tag: "dedicated-2", kind: "dedicated" as const, clusterId: "cluster-b" };

    const nodeWorkloadsA = { services: [{ name: "app-a", type: "web" }] };
    const nodeWorkloadsB = { services: [{ name: "app-b", type: "web" }] };

    const db = makeDb({
      instances: [dedicatedInstA, dedicatedInstB],
      clusters: [clusterA, clusterB],
    });
    const kv = makeKv({
      [dedicatedTag]: nodeWorkloadsA,
      "dedicated-2": nodeWorkloadsB,
    });
    const connManager = makeConnectionManager([dedicatedTag, "dedicated-2"]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    assert.equal(topology.length, 2, "two nodes");

    const nodeA = topology.find((n) => n.tag === dedicatedTag);
    const nodeB = topology.find((n) => n.tag === "dedicated-2");

    assert.ok(nodeA, "node A exists");
    assert.ok(nodeB, "node B exists");

    assert.equal(nodeA!.clusters.length, 1, "node A has 1 cluster");
    assert.equal(nodeA!.clusters[0].id, "cluster-a");

    assert.equal(nodeB!.clusters.length, 1, "node B has 1 cluster");
    assert.equal(nodeB!.clusters[0].id, "cluster-b");
  });

  it("matches services by name, not ID (stale deployment ID scenario)", async () => {
    const poolTag = "pool-1";

    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    const newDep = { id: "dep-new-id", clusterId: "cluster-a", name: "app" };

    // Node reports service with old deployment ID (stale from reprovisioning)
    const nodeWorkloads = {
      services: [{ name: "app", type: "web", deployment_id: "dep-old-id-that-no-longer-exists" }],
    };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [newDep],  // Only new deployment exists
    });
    const kv = makeKv({ [poolTag]: nodeWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    const node = topology[0];
    const clusterAView = node.clusters[0];

    assert.equal(clusterAView.broadcastServices.length, 1, "service matched by name despite stale ID");
    assert.equal(clusterAView.broadcastServices[0].name, "app");
  });

  it("handles pool node with many clusters correctly", async () => {
    const poolTag = "pool-1";
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    // Create 5 clusters on same pool
    const clusters = Array.from({ length: 5 }, (_, i) => ({
      id: `cluster-${i}`,
      name: `Cluster ${i}`,
      poolInstanceId: "pool-inst-1",
    }));

    const deployments = clusters.map((c, i) => ({
      id: `dep-${i}`,
      clusterId: c.id,
      name: `app-${i}`,
    }));

    const nodeWorkloads = {
      services: clusters.map((_, i) => ({ name: `app-${i}`, type: "web" })),
    };

    const db = makeDb({
      instances: [poolInstance],
      clusters,
      deployments,
    });
    const kv = makeKv({ [poolTag]: nodeWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    const node = topology[0];
    assert.equal(node.clusters.length, 5, "node has 5 clusters");

    // Each cluster should see only its own service
    for (let i = 0; i < 5; i++) {
      const clusterView = node.clusters[i];
      assert.equal(clusterView.broadcastServices.length, 1, `cluster ${i} sees 1 service`);
      assert.equal(clusterView.broadcastServices[0].name, `app-${i}`);
    }

    assert.equal(node.rawNodeServices.length, 0, "no unmatched services");
  });

  it("separates matched and unmatched services correctly", async () => {
    const poolTag = "pool-1";

    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const clusterB = { id: "cluster-b", name: "Cluster B", poolInstanceId: "pool-inst-1" };
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    const depA = { id: "dep-a", clusterId: "cluster-a", name: "app-a" };

    // Mix of matched and unmatched services
    const nodeWorkloads = {
      services: [
        { name: "app-a", type: "web" },       // Matches cluster A
        { name: "orphaned-1", type: "web" },  // Unmatched
        { name: "orphaned-2", type: "web" },  // Unmatched
      ],
    };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA, clusterB],
      deployments: [depA],
    });
    const kv = makeKv({ [poolTag]: nodeWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    const node = topology[0];

    // Cluster A should see its service
    const clusterAView = node.clusters.find((c) => c.id === "cluster-a");
    assert.equal(clusterAView!.broadcastServices.length, 1);

    // Cluster B should see nothing
    const clusterBView = node.clusters.find((c) => c.id === "cluster-b");
    assert.equal(clusterBView!.broadcastServices.length, 0);

    // Raw node services should show unmatched
    assert.equal(node.rawNodeServices.length, 2, "2 unmatched services");
    const orphanedNames = node.rawNodeServices.map((s) => s.name).sort();
    assert.deepEqual(orphanedNames, ["orphaned-1", "orphaned-2"]);
  });
});
