// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClientMessageHandler } from "@/services/websocket/handlers/client-handler.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

function makeKv(kvData: Record<string, { data: any; version: number }>) {
  return {
    entities: {
      getEntity: async (key: string) => kvData[key] ?? null,
    },
    kv: { get: async () => null },
  } as any;
}

function makeDb({
  cluster,
  services = [],
  deployments = [],
}: {
  cluster: { id: string; poolInstanceId?: string };
  services?: any[];
  deployments?: any[];
}) {
  return {
    clusters: {
      find: async () => cluster,
    },
    instances: {
      find: async (filter: any) => {
        if (filter.id === cluster.poolInstanceId) return { tag: "pool-node-1", id: cluster.poolInstanceId };
        return null;
      },
    },
    services: {
      list: async () => ({ services }),
    },
    deployments: {
      list: async () => ({ deployments }),
      get: async () => null,
    },
  } as any;
}

function makeConn(clusterId: string) {
  const sent: any[] = [];
  return {
    conn: {
      connectionKey: clusterId,
      connectionId: "conn-1",
      ws: { send: (msg: string) => sent.push(JSON.parse(msg)) },
      session: { clusters: [{ id: clusterId }] },
    } as any,
    sent,
  };
}

function makeConnectionManager() {
  return {
    updateActivity: () => {},
    sendHeartbeat: () => false,
    getClientVersion: () => 0,
    setClientVersion: () => {},
  } as any;
}

const heartbeatMsg = (versions: Record<string, any> = {}) => ({
  kind: "heartbeat",
  versions,
}) as any;


describe("ClientMessageHandler.handleHeartbeat — cluster workload isolation", () => {
  it("sends only the cluster-scoped workloads, not raw node workloads", async () => {
    const clusterId = "cluster-maverick";
    const instanceId = "pool-node-1";
    const poolInstanceId = "pool-inst-1";

    const cluster = { id: clusterId, poolInstanceId };

    // Raw node key has all services (ceejotter's ronaldo + maverick's nothing)
    const rawKey = KV_KEYS.INSTANCE.ENTITY(instanceId, "workloads");
    // Cluster-scoped key has only maverick's filtered (empty) services
    const clusterKey = KV_KEYS.CLUSTER.WORKLOADS(clusterId, instanceId);

    const kv = makeKv({
      [rawKey]: { data: { services: [{ name: "ronaldo", type: "web" }] }, version: 5 },
      [clusterKey]: { data: { services: [] }, version: 3 },
    });

    const db = makeDb({ cluster });
    const { conn, sent } = makeConn(clusterId);

    const handler = new ClientMessageHandler({
      connectionManager: makeConnectionManager(),
      kv,
      db,
      jwtService: {} as any,
      dployrdService: {} as any,
      terminalManager: {} as any,
    });

    await handler.handleMessage(conn, heartbeatMsg());

    // The client should NOT receive "ronaldo" — it belongs to another cluster
    const workloadUpdates = sent
      .filter((m) => m.kind === "delta-update" && m.sections?.workloads)
      .flatMap((m) => m.sections.workloads.data?.services ?? []);

    assert.ok(
      !workloadUpdates.some((s: any) => s.name === "ronaldo"),
      "maverick client must not receive ronaldo (belongs to ceejotter)"
    );
  });

  it("sends the correct cluster-scoped services when the cluster has its own service", async () => {
    const clusterId = "cluster-ceejotter";
    const instanceId = "pool-node-1";
    const poolInstanceId = "pool-inst-1";

    const cluster = { id: clusterId, poolInstanceId };

    const rawKey = KV_KEYS.INSTANCE.ENTITY(instanceId, "workloads");
    const clusterKey = KV_KEYS.CLUSTER.WORKLOADS(clusterId, instanceId);

    const kv = makeKv({
      [rawKey]: { data: { services: [{ name: "ronaldo", type: "web" }, { name: "maverick-app", type: "web" }] }, version: 5 },
      [clusterKey]: { data: { services: [{ name: "ronaldo", type: "web" }] }, version: 3 },
    });

    const db = makeDb({ cluster });
    const { conn, sent } = makeConn(clusterId);

    const handler = new ClientMessageHandler({
      connectionManager: makeConnectionManager(),
      kv,
      db,
      jwtService: {} as any,
      dployrdService: {} as any,
      terminalManager: {} as any,
    });

    await handler.handleMessage(conn, heartbeatMsg());

    const workloadUpdates = sent
      .filter((m) => m.kind === "delta-update" && m.sections?.workloads)
      .flatMap((m) => m.sections.workloads.data?.services ?? []);

    assert.ok(workloadUpdates.some((s: any) => s.name === "ronaldo"), "ceejotter receives its own service");
    assert.ok(!workloadUpdates.some((s: any) => s.name === "maverick-app"), "ceejotter does not receive maverick's service");
  });

  it("falls back to DB synthetic workloads when no cluster-scoped KV key exists yet", async () => {
    const clusterId = "cluster-new";
    const instanceId = "pool-node-1";
    const poolInstanceId = "pool-inst-1";

    const cluster = { id: clusterId, poolInstanceId };

    // Only raw node key exists (no cluster-scoped key written yet)
    const rawKey = KV_KEYS.INSTANCE.ENTITY(instanceId, "workloads");

    const kv = makeKv({
      [rawKey]: { data: { services: [{ name: "other-cluster-service", type: "web" }] }, version: 5 },
      // No CLUSTER.WORKLOADS key — simulates a fresh deploy before first node broadcast
    });

    const dbService = { id: "svc-1", name: "my-service", type: "web", clusterId, createdAt: Date.now(), updatedAt: Date.now() };
    const db = makeDb({ cluster, services: [dbService] });
    const { conn, sent } = makeConn(clusterId);

    const handler = new ClientMessageHandler({
      connectionManager: makeConnectionManager(),
      kv,
      db,
      jwtService: {} as any,
      dployrdService: {} as any,
      terminalManager: {} as any,
    });

    await handler.handleMessage(conn, heartbeatMsg());

    const workloadUpdates = sent
      .filter((m) => m.kind === "delta-update" && m.sections?.workloads)
      .flatMap((m) => m.sections.workloads.data?.services ?? []);

    // Should not see the raw node's services
    assert.ok(!workloadUpdates.some((s: any) => s.name === "other-cluster-service"), "raw node services not leaked");
    // Should see the DB fallback service
    assert.ok(workloadUpdates.some((s: any) => s.name === "my-service"), "DB fallback service is shown");
  });
});
