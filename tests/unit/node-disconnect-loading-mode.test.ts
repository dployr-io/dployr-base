// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeMessageHandler } from "@/services/websocket/handlers/node-handler.js";
import { setServicesLoadingMode } from "@/services/websocket/instance-handler.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

function makeKv(opts: { deregistered?: string[][] } = {}) {
  const deregistered: string[][] = opts.deregistered ?? [];
  return {
    deregistered,
    kv: {
      entities: { getEntity: async () => null },
      instanceCache: {
        deregisterClusterNode: async (clusterId: string, nodeId: string) => {
          deregistered.push([clusterId, nodeId]);
        },
      },
      payloads: { consumeDeploymentPayload: async () => null },
    } as any,
  };
}

function makeDb(clusters: Array<{ id: string; name: string }>) {
  return {
    clusters: {
      list: async () => ({ clusters }),
    },
    deployments: { list: async () => ({ deployments: [] }) },
    services: { list: async () => ({ services: [] }) },
    serviceEnvs: { list: async () => [] },
  } as any;
}

const noopConnectionManager = {
  updateActivity: () => {},
  getPendingRequest: () => null,
  routeResponseToClient: () => {},
  getLogStream: () => null,
  getFileWatchSubscribers: () => null,
  getConnections: () => [],
} as any;

function makeNotifier() {
  const calls: Array<{ clusterId: string; entity: string }> = [];
  return {
    notifier: { broadcast: async () => {}, notifyRefresh: (clusterId: string, entity: string) => { calls.push({ clusterId, entity }); } } as any,
    calls,
  };
}

const noopNotifier = { broadcast: async () => {}, notifyRefresh: () => {} } as any;
const noopJwt = { createNodeAccessToken: async () => "tok" } as any;

function handler(db: any, kv: any) {
  return new NodeMessageHandler(noopConnectionManager, noopNotifier, db, kv, noopJwt);
}

describe("NodeMessageHandler.handleNodeDisconnect — cluster ID return", () => {
  it("pool node: deregisters all clusters and returns their IDs", async () => {
    const clusterA = { id: "cluster-a", name: "A" };
    const clusterB = { id: "cluster-b", name: "B" };
    const { deregistered, kv } = makeKv();
    const db = makeDb([clusterA, clusterB]);

    const conn = { connectionKey: "pool-1", instanceTag: "pool-1", clusterId: undefined, role: "node" } as any;
    const clusterIds = await handler(db, kv).handleNodeDisconnect(conn);

    assert.deepEqual(clusterIds.sort(), ["cluster-a", "cluster-b"]);
    assert.equal(deregistered.length, 2);
  });

  it("dedicated node: deregisters only its cluster and returns [clusterId]", async () => {
    const { deregistered, kv } = makeKv();
    const db = makeDb([]);

    const conn = { connectionKey: "node-1", instanceTag: "node-1", clusterId: "cluster-x", role: "node" } as any;
    const clusterIds = await handler(db, kv).handleNodeDisconnect(conn);

    assert.deepEqual(clusterIds, ["cluster-x"]);
    assert.deepEqual(deregistered, [["cluster-x", "node-1"]]);
  });

  it("returns empty array when instanceTag is missing", async () => {
    const { kv } = makeKv();
    const db = makeDb([]);

    const conn = { connectionKey: "anon", instanceTag: undefined, clusterId: undefined, role: "node" } as any;
    const clusterIds = await handler(db, kv).handleNodeDisconnect(conn);

    assert.deepEqual(clusterIds, []);
  });
});

describe("node disconnect → Traefik loading mode + SLEEPING cleared", () => {
  const services = [
    { id: "s1", name: "api", clusterId: "cluster-a" },
    { id: "s2", name: "worker", clusterId: "cluster-a" },
  ];

  function makeDisconnectDb() {
    return {
      clusters: { list: async () => ({ clusters: [{ id: "cluster-a", name: "A" }] }) },
      deployments: { list: async () => ({ deployments: [] }) },
      services: {
        list: async (filter: any) => ({
          services: filter?.clusterId
            ? services.filter((s) => s.clusterId === filter.clusterId)
            : services,
        }),
      },
      serviceEnvs: { list: async () => [] },
    } as any;
  }

  it("calls setLoadingMode for every service in the affected clusters", async () => {
    const db = makeDisconnectDb();
    const loadingModeCalls: string[] = [];
    const traefik = { setLoadingMode: async (name: string) => { loadingModeCalls.push(name); } };
    const kv = { put: async () => {} };

    await setServicesLoadingMode(["cluster-a"], db.services, kv, traefik);

    assert.deepEqual(loadingModeCalls.sort(), ["api", "worker"]);
  });

  it("calls notifyRefresh for every affected cluster on disconnect", async () => {
    const { kv } = makeKv();
    const db = makeDisconnectDb();
    const { notifier, calls } = makeNotifier();

    const conn = { connectionKey: "pool-1", instanceTag: "pool-1", clusterId: undefined, role: "node" } as any;
    await new NodeMessageHandler(noopConnectionManager, notifier, db, kv, noopJwt).handleNodeDisconnect(conn);

    assert.deepEqual(calls, [{ clusterId: "cluster-a", entity: "services" }]);
  });

  it("notifyRefresh is NOT called when instanceTag is missing", async () => {
    const { kv } = makeKv();
    const db = makeDisconnectDb();
    const { notifier, calls } = makeNotifier();

    const conn = { connectionKey: "anon", instanceTag: undefined, clusterId: undefined, role: "node" } as any;
    await new NodeMessageHandler(noopConnectionManager, notifier, db, kv, noopJwt).handleNodeDisconnect(conn);

    assert.equal(calls.length, 0);
  });

  it("sets the SLEEPING flag for every affected service on disconnect", async () => {
    const db = makeDisconnectDb();
    const putEntries: Array<[string, string]> = [];
    const kv = { put: async (key: string, value: string) => { putEntries.push([key, value]); } };
    const traefik = { setLoadingMode: async () => {} };

    await setServicesLoadingMode(["cluster-a"], db.services, kv, traefik);

    assert.deepEqual(
      putEntries.filter(([k]) => k.startsWith("svc:sleeping:")).sort((a, b) => a[0].localeCompare(b[0])),
      [[KV_KEYS.SERVICE.SLEEPING("api"), "1"], [KV_KEYS.SERVICE.SLEEPING("worker"), "1"]],
    );
  });
});
