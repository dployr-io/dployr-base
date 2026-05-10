// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AdminService } from "@/services/admin.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string };
type FakeDeployment = { id: string; clusterId: string; name: string };

function makeDb({
  instances = [] as FakeInstance[],
  clusters = [] as FakeCluster[],
  deployments = [] as FakeDeployment[],
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
        services: [],  // No services in DB for these tests
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

describe("Monitor stability — large workloads and stress", () => {
  it("handles pool node with 50+ services across 5 clusters", async () => {
    const poolTag = "pool-1";
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    // 5 clusters
    const clusters = Array.from({ length: 5 }, (_, i) => ({
      id: `cluster-${i}`,
      name: `Cluster ${i}`,
      poolInstanceId: "pool-inst-1",
    }));

    // 10 deployments per cluster (50 total)
    const deployments = clusters.flatMap((c, ci) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `dep-${ci}-${i}`,
        clusterId: c.id,
        name: `app-${ci}-${i}`,
      }))
    );

    // Node reports all 50 services
    const nodeWorkloads = {
      services: deployments.map((d) => ({ name: d.name, type: "web" })),
    };

    const db = makeDb({ instances: [poolInstance], clusters, deployments });
    const kv = makeKv({ [poolTag]: nodeWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const startTime = performance.now();
    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();
    const elapsed = performance.now() - startTime;

    assert.equal(topology.length, 1, "one node");
    assert.equal(topology[0].clusters.length, 5, "five clusters");

    // Each cluster should see exactly 10 services
    for (let i = 0; i < 5; i++) {
      const clusterView = topology[0].clusters[i];
      assert.equal(
        clusterView.broadcastServices.length,
        10,
        `cluster ${i} sees 10 services`
      );
    }

    assert.ok(elapsed < 1000, `topology computed in ${elapsed}ms (under 1s)`);
  });

  it("handles node disconnect/reconnect cycle", async () => {
    const poolTag = "pool-1";
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };
    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const dep = { id: "dep-a", clusterId: "cluster-a", name: "api" };

    const nodeWorkloads = { services: [{ name: "api", type: "web" }] };

    const db = makeDb({ instances: [poolInstance], clusters: [clusterA], deployments: [dep] });
    const kv = makeKv({ [poolTag]: nodeWorkloads });

    // Phase 1: Node connected
    let connManager = makeConnectionManager([poolTag]);
    let adminService = new AdminService(db, kv, connManager);
    let topology = await adminService.getTopology();

    assert.equal(topology[0].connected, true, "node connected");
    assert.equal(topology[0].clusters[0].broadcastServices.length, 1);

    // Phase 2: Node disconnects (but KV still has data)
    connManager = makeConnectionManager([]);
    adminService = new AdminService(db, kv, connManager);
    topology = await adminService.getTopology();

    assert.equal(topology[0].connected, false, "node disconnected");
    // Note: Monitor still shows services from KV - they persist even if node is offline
    assert.equal(topology[0].clusters[0].broadcastServices.length, 1, "services remain in topology even when disconnected");

    // Phase 3: Node reconnects
    connManager = makeConnectionManager([poolTag]);
    adminService = new AdminService(db, kv, connManager);
    topology = await adminService.getTopology();

    assert.equal(topology[0].connected, true, "node reconnected");
    assert.equal(topology[0].clusters[0].broadcastServices.length, 1, "service still visible");
  });

  it("handles many pools (10+) without cross-contamination", async () => {
    // 10 pool nodes
    const pools = Array.from({ length: 10 }, (_, i) => ({
      id: `pool-${i}`,
      tag: `pool-${i}`,
      kind: "pool" as const,
    }));

    // 2 clusters per pool
    const clusters = pools.flatMap((p, pi) =>
      Array.from({ length: 2 }, (_, ci) => ({
        id: `cluster-${pi}-${ci}`,
        name: `Cluster ${pi}-${ci}`,
        poolInstanceId: p.id,
      }))
    );

    // 1 deployment per cluster
    const deployments = clusters.map((c, i) => ({
      id: `dep-${i}`,
      clusterId: c.id,
      name: `app-${i}`,
    }));

    // Each pool node reports its clusters' services
    const workloads: Record<string, { services: any[] }> = {};
    for (let pi = 0; pi < 10; pi++) {
      const clusterIndices = [pi * 2, pi * 2 + 1];
      workloads[`pool-${pi}`] = {
        services: clusterIndices.map((ci) => ({
          name: `app-${ci}`,
          type: "web",
        })),
      };
    }

    const db = makeDb({ instances: pools, clusters, deployments });
    const kv = makeKv(workloads);
    const connManager = makeConnectionManager(pools.map((p) => p.tag));

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    assert.equal(topology.length, 10, "10 nodes");

    // Each pool should have exactly 2 clusters with 1 service each
    for (let pi = 0; pi < 10; pi++) {
      const node = topology.find((n) => n.id === `pool-${pi}`);
      assert.ok(node, `pool ${pi} in topology`);
      assert.equal(node!.clusters.length, 2, `pool ${pi} has 2 clusters`);

      const clusterViews = node!.clusters;
      assert.equal(clusterViews[0].broadcastServices.length, 1);
      assert.equal(clusterViews[1].broadcastServices.length, 1);

      // Services should be from their respective clusters, not mixed
      const service0 = clusterViews[0].broadcastServices[0].name;
      const service1 = clusterViews[1].broadcastServices[0].name;
      assert.notEqual(service0, service1, `clusters in pool ${pi} have different services`);
    }
  });

  it("handles service list with gaps (some nodes have empty workloads)", async () => {
    const pool1 = { id: "pool-1", tag: "pool-1", kind: "pool" as const };
    const pool2 = { id: "pool-2", tag: "pool-2", kind: "pool" as const };

    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-1" };
    const clusterB = { id: "cluster-b", name: "Cluster B", poolInstanceId: "pool-2" };

    const depA = { id: "dep-a", clusterId: "cluster-a", name: "api" };
    const depB = { id: "dep-b", clusterId: "cluster-b", name: "api" };

    const db = makeDb({
      instances: [pool1, pool2],
      clusters: [clusterA, clusterB],
      deployments: [depA, depB],
    });

    const kv = makeKv({
      "pool-1": { services: [{ name: "api", type: "web" }] },
      // pool-2 has no workload data (not reported yet)
    });

    const connManager = makeConnectionManager(["pool-1", "pool-2"]);
    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    assert.equal(topology.length, 2, "both nodes in topology");

    const node1 = topology.find((n) => n.id === "pool-1");
    const node2 = topology.find((n) => n.id === "pool-2");

    assert.equal(node1!.clusters[0].broadcastServices.length, 1, "pool-1 has service");
    assert.equal(node2!.clusters[0].broadcastServices.length, 0, "pool-2 has no service (no data yet)");
  });

  it("handles duplicate service reports from node", async () => {
    const poolTag = "pool-1";
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };
    const clusterA = { id: "cluster-a", name: "Cluster A", poolInstanceId: "pool-inst-1" };
    const dep = { id: "dep-a", clusterId: "cluster-a", name: "api" };

    // Node reports same service 3 times (shouldn't happen but node data persists as-is)
    const nodeWorkloads = {
      services: [
        { name: "api", type: "web" },
        { name: "api", type: "web" },
        { name: "api", type: "web" },
      ],
    };

    const db = makeDb({
      instances: [poolInstance],
      clusters: [clusterA],
      deployments: [dep],
    });
    const kv = makeKv({ [poolTag]: nodeWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const adminService = new AdminService(db, kv, connManager);
    const topology = await adminService.getTopology();

    const node = topology[0];
    const clusterView = node.clusters[0];

    // Broadcastservices includes the service (matching is done by name against deployments)
    assert.ok(clusterView.broadcastServices.length >= 1, "service appears in cluster view");
  });

  it("handles many clusters on one pool (15 clusters)", async () => {
    const poolTag = "pool-1";
    const poolInstance = { id: "pool-inst-1", tag: poolTag, kind: "pool" as const };

    // 15 clusters on one pool
    const clusters = Array.from({ length: 15 }, (_, i) => ({
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
      services: deployments.map((d) => ({ name: d.name, type: "web" })),
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
    assert.equal(node.clusters.length, 15, "all 15 clusters present");

    // Each should have exactly 1 service matching its name
    for (let i = 0; i < 15; i++) {
      assert.equal(
        node.clusters[i].broadcastServices.length,
        1,
        `cluster ${i} has 1 service`
      );
    }

    // No unmatched services (all services matched their clusters)
    assert.equal(node.rawNodeServices.length, 0, "no unmatched services");
  });
});
