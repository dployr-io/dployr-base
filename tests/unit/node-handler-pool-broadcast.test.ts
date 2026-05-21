// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeMessageHandler } from "@/services/websocket/handlers/node-handler.js";
import { KV_KEYS } from "@/lib/constants/kv.js";


function makeKv(workloadsByInstanceId: Record<string, { services: any[]; deployments?: any[] }>) {
  const writes: Record<string, any> = {};
  return {
    writes,
    kv: {
      entities: {
        getEntity: async (key: string) => {
          for (const [instanceId, data] of Object.entries(workloadsByInstanceId)) {
            if (key === KV_KEYS.INSTANCE.ENTITY(instanceId, "workloads")) {
              return { data, version: 1 };
            }
          }
          return null;
        },
        setEntity: async (key: string, data: any) => {
          writes[key] = data;
          return { version: 2 };
        },
      },
      instanceCache: {
        registerClusterNode: async () => {},
      },
      payloads: {
        consumeDeploymentPayload: async () => null,
      },
    } as any,
  };
}

function makeDb({
  clusters,
  deployments,
  services = [],
}: {
  clusters: Array<{ id: string; name: string }>;
  deployments: Array<{ id: string; clusterId: string; name: string; userId: string }>;
  services?: Array<{ id: string; clusterId: string; name: string }>;
}) {
  return {
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
      upsert: async () => null,
    },
    services: {
      list: async (filter: any) => ({
        services: filter?.clusterId
          ? services.filter((s) => s.clusterId === filter.clusterId)
          : services,
      }),
    },
    serviceEnvs: {
      list: async () => [],
    },
  } as any;
}

function makeConnectionManager() {
  return {
    updateActivity: () => {},
    getPendingRequest: () => null,
    routeResponseToClient: () => {},
    getLogStream: () => null,
    getFileWatchSubscribers: () => null,
    getConnections: () => [],
  } as any;
}

const noopNotifier = {
  broadcast: async () => {},
  notifyRefresh: () => {},
} as any;

const noopJwtService = {
  createNodeAccessToken: async () => "mock-token",
} as any;

// Pool node connection (no clusterId)
function poolConn(instanceTag: string) {
  return { clusterId: undefined, instanceTag, ws: { readyState: 1 } } as any;
}

// handleNodeBroadcast is fire-and-forget inside handleMessage.
// Waiting one macrotask tick drains all pending microtasks so KV writes are visible.
const flush = () => new Promise((r) => setTimeout(r, 0));

function broadcastMsg(instanceId: string, workloads: any) {
  return {
    kind: "update",
    update: {
      schema: "v1.1",
      instance_id: instanceId,
      sequence: 1,
      epoch: "0",
      timestamp: new Date().toISOString(),
      is_full_sync: false,
      workloads,
    },
  } as any;
}


describe("NodeMessageHandler — pool workloads written to cluster-scoped KV keys", () => {
  it("writes only cluster A's services and deployments to cluster A's KV key and cluster B's to cluster B's", async () => {
    const instanceId = "pool-node-1";

    const clusterA = { id: "cluster-a", name: "Cluster A" };
    const clusterB = { id: "cluster-b", name: "Cluster B" };

    const depA = { id: "dep-a", clusterId: "cluster-a", name: "app-a", userId: "u1" };
    const depB = { id: "dep-b", clusterId: "cluster-b", name: "app-b", userId: "u2" };

    const poolWorkloads = {
      services: [
        { name: "app-a", type: "web" },
        { name: "app-b", type: "web" },
      ],
      deployments: [
        { id: "dep-a", name: "app-a", status: "success" },
        { id: "dep-b", name: "app-b", status: "success" },
      ],
    };

    const { writes, kv } = makeKv({ [instanceId]: poolWorkloads });
    const db = makeDb({ clusters: [clusterA, clusterB], deployments: [depA, depB] });

    const handler = new NodeMessageHandler(makeConnectionManager(), noopNotifier, db, kv, noopJwtService);
    await handler.handleMessage({ conn: poolConn(instanceId), message: broadcastMsg(instanceId, poolWorkloads) });
    await flush();

    const keyA = KV_KEYS.CLUSTER.WORKLOADS("cluster-a", instanceId);
    const keyB = KV_KEYS.CLUSTER.WORKLOADS("cluster-b", instanceId);

    assert.ok(writes[keyA], "cluster A workloads key was written");
    assert.ok(writes[keyB], "cluster B workloads key was written");

    assert.deepEqual(writes[keyA].services.map((s: any) => s.name), ["app-a"]);
    assert.deepEqual(writes[keyB].services.map((s: any) => s.name), ["app-b"]);

    assert.deepEqual(writes[keyA].deployments.map((d: any) => d.name), ["app-a"], "cluster A does not see cluster B deployments");
    assert.deepEqual(writes[keyB].deployments.map((d: any) => d.name), ["app-b"], "cluster B does not see cluster A deployments");
  });

  it("writes empty services to a cluster that has no matching deployments", async () => {
    const instanceId = "pool-node-1";

    const clusterA = { id: "cluster-a", name: "Cluster A" };
    const clusterB = { id: "cluster-b", name: "Cluster B" };

    const depA = { id: "dep-a", clusterId: "cluster-a", name: "app-a", userId: "u1" };

    const poolWorkloads = {
      services: [{ name: "app-a", type: "web", deployment_id: "dep-a" }],
    };

    const { writes, kv } = makeKv({ [instanceId]: poolWorkloads });
    const db = makeDb({ clusters: [clusterA, clusterB], deployments: [depA] });

    const handler = new NodeMessageHandler(makeConnectionManager(), noopNotifier, db, kv, noopJwtService);
    await handler.handleMessage({ conn: poolConn(instanceId), message: broadcastMsg(instanceId, poolWorkloads) });
    await flush();

    const keyB = KV_KEYS.CLUSTER.WORKLOADS("cluster-b", instanceId);
    assert.ok(writes[keyB], "cluster B workloads key was written");
    assert.deepEqual(writes[keyB].services, [], "cluster B receives empty services");
  });

  it("matches services by name even with stale deployment IDs (reprovisioning)", async () => {
    const instanceId = "pool-node-1";
    const clusterA = { id: "cluster-a", name: "Cluster A" };
    const newDep = { id: "dep-new-id", clusterId: "cluster-a", name: "app-a", userId: "u1" };

    const poolWorkloads = {
      services: [{ name: "app-a", type: "web", deployment_id: "dep-old-id-stale" }],
    };

    const { writes, kv } = makeKv({ [instanceId]: poolWorkloads });
    const db = makeDb({ clusters: [clusterA], deployments: [newDep] });

    const handler = new NodeMessageHandler(makeConnectionManager(), noopNotifier, db, kv, noopJwtService);
    await handler.handleMessage({ conn: poolConn(instanceId), message: broadcastMsg(instanceId, poolWorkloads) });
    await flush();

    const keyA = KV_KEYS.CLUSTER.WORKLOADS("cluster-a", instanceId);
    assert.ok(writes[keyA], "cluster A workloads key was written");
    assert.equal(writes[keyA].services.length, 1, "service matched by name despite stale deployment ID");
    assert.equal(writes[keyA].services[0].name, "app-a");
  });

  it("excludes services with no matching deployment by name", async () => {
    const instanceId = "pool-node-1";
    const clusterA = { id: "cluster-a", name: "Cluster A" };
    const depA = { id: "dep-a", clusterId: "cluster-a", name: "app-a", userId: "u1" };

    const poolWorkloads = {
      services: [
        { name: "app-a", type: "web" },
        { name: "orphaned", type: "web" },
      ],
    };

    const { writes, kv } = makeKv({ [instanceId]: poolWorkloads });
    const db = makeDb({ clusters: [clusterA], deployments: [depA] });

    const handler = new NodeMessageHandler(makeConnectionManager(), noopNotifier, db, kv, noopJwtService);
    await handler.handleMessage({ conn: poolConn(instanceId), message: broadcastMsg(instanceId, poolWorkloads) });
    await flush();

    const keyA = KV_KEYS.CLUSTER.WORKLOADS("cluster-a", instanceId);
    assert.equal(writes[keyA].services.length, 1, "only matched service written");
    assert.equal(writes[keyA].services[0].name, "app-a");
  });
});
