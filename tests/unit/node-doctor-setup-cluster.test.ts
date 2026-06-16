// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { NodeDoctor } from "@/lib/node/node-doctor.js";

// ── key-pair fixture (generated once per test run) ────────────────────────────

let privateKey: CryptoKey;
let publicKeyJwk: JsonWebKey & { kid: string };

async function ensureKeyPair() {
  if (privateKey) return;
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = pair.privateKey;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicKeyJwk = { ...pub, kid: "test-kid" } as JsonWebKey & { kid: string };
}

// ── shared factories ──────────────────────────────────────────────────────────

function makeKvWithKeys() {
  return {
    kv: {
      async get() { return null; },
      async put() {},
      async delete() {},
    },
    instanceCache: {
      async getInFlightBuilds() { return []; },
      async clearInFlightBuilds() {},
      async checkForDecommissionFlag() { return false; },
      async setFlagForDecommission() {},
      async isInRecoveryWindow() { return false; },
    },
    payloads: { async enqueueBuild() {} },
    entities: { async getEntity() { return null; } },
    getPrivateKey: async () => privateKey,
    getPublicKey: async () => publicKeyJwk,
  } as any;
}

function makeConn() {
  return { emit: async () => {}, getNodeConnections: () => [], sendTask: () => false } as any;
}

function makeDoctor({ db, pool = {} as any, conn = makeConn() }: { db: any; pool?: any; conn?: any }) {
  return new NodeDoctor({ db, kv: makeKvWithKeys(), vm: null, conn, pool });
}

// ── sendSetupClusterTask ──────────────────────────────────────────────────────

describe("NodeDoctor.sendSetupClusterTask — cgroup slice task dispatch", () => {
  before(ensureKeyPair);

  it("does not call conn.sendTask for a pro cluster (clusterMemory === 0)", async () => {
    const sentTasks: any[] = [];
    const conn = { ...makeConn(), sendTask: (_key: string, task: any) => { sentTasks.push(task); return true; } };
    const db = {
      instances: { getRoutingKey: async () => "node-tag-1" },
    } as any;

    const doctor = makeDoctor({ db, conn });
    await (doctor as any).sendSetupClusterTask("cluster-pro", "pro");

    assert.deepEqual(sentTasks, [], "must not send task for pro tier");
  });

  it("calls conn.sendTask with clusters/setup:post type for a hobby cluster", async () => {
    const sentTasks: { routingKey: string; task: any }[] = [];
    const conn = { ...makeConn(), sendTask: (key: string, task: any) => { sentTasks.push({ routingKey: key, task }); return true; } };
    const db = {
      instances: { getRoutingKey: async () => "node-hobby-1" },
    } as any;

    const doctor = makeDoctor({ db, conn });
    await (doctor as any).sendSetupClusterTask("cluster-hobby-1", "hobby");

    assert.equal(sentTasks.length, 1, "must send exactly one task");
    assert.equal(sentTasks[0].routingKey, "node-hobby-1");
    assert.equal(sentTasks[0].task.Type, "clusters/setup:post");
    assert.equal(sentTasks[0].task.Payload.cluster_id, "cluster-hobby-1");
    assert.equal(sentTasks[0].task.Payload.cluster_memory, 64, "hobby cluster_memory must be 64 MB");
    assert.equal(sentTasks[0].task.Payload.cluster_cpu, 100, "hobby cluster_cpu must be 100 millicores");
    assert.equal(sentTasks[0].task.Status, "pending");
  });

  it("calls conn.sendTask with correct limits for an indie cluster", async () => {
    const sentTasks: { routingKey: string; task: any }[] = [];
    const conn = { ...makeConn(), sendTask: (key: string, task: any) => { sentTasks.push({ routingKey: key, task }); return true; } };
    const db = {
      instances: { getRoutingKey: async () => "node-indie-1" },
    } as any;

    const doctor = makeDoctor({ db, conn });
    await (doctor as any).sendSetupClusterTask("cluster-indie-1", "indie");

    assert.equal(sentTasks.length, 1);
    assert.equal(sentTasks[0].task.Type, "clusters/setup:post");
    assert.equal(sentTasks[0].task.Payload.cluster_memory, 512, "indie cluster_memory must be 512 MB");
    assert.equal(sentTasks[0].task.Payload.cluster_cpu, 250, "indie cluster_cpu must be 250 millicores");
  });

  it("sends task to the routing key returned by getRoutingKey", async () => {
    const routingKeys: string[] = [];
    const conn = { ...makeConn(), sendTask: (key: string) => { routingKeys.push(key); return true; } };
    const db = {
      instances: { getRoutingKey: async (_id: string) => "assigned-node-tag" },
    } as any;

    const doctor = makeDoctor({ db, conn });
    await (doctor as any).sendSetupClusterTask("cluster-abc", "hobby");

    assert.deepEqual(routingKeys, ["assigned-node-tag"]);
  });
});

// ── allocateForPlan → sendSetupClusterTask integration ───────────────────────

describe("NodeDoctor.allocateForPlan — setup task dispatch on allocation", () => {
  it("fires sendSetupClusterTask after allocateSharedPool for hobby", async () => {
    const setupCalls: { clusterId: string; plan: string }[] = [];
    const poolAllocations: string[] = [];

    const db = {
      instances: { getRoutingKey: async () => "node-1", releasePoolInstance: async () => {} },
      billing: {},
    } as any;
    const pool = {
      allocateSharedPool: async (clusterId: string) => { poolAllocations.push(clusterId); },
      spawnDedicatedInstance: async () => { throw new Error("must not spawn dedicated for hobby"); },
    };

    const doctor = makeDoctor({ db, pool });
    (doctor as any).sendSetupClusterTask = async (clusterId: string, plan: string) => {
      setupCalls.push({ clusterId, plan });
    };

    await (doctor as any).allocateForPlan("cluster-hobby", "hobby-cluster", "hobby");

    assert.deepEqual(poolAllocations, ["cluster-hobby"]);
    assert.deepEqual(setupCalls, [{ clusterId: "cluster-hobby", plan: "hobby" }]);
  });

  it("fires sendSetupClusterTask after allocateSharedPool for indie", async () => {
    const setupCalls: { clusterId: string; plan: string }[] = [];
    const db = {
      instances: { getRoutingKey: async () => "node-1", releasePoolInstance: async () => {} },
    } as any;
    const pool = {
      allocateSharedPool: async () => {},
      spawnDedicatedInstance: async () => { throw new Error("must not spawn dedicated for indie"); },
    };

    const doctor = makeDoctor({ db, pool });
    (doctor as any).sendSetupClusterTask = async (clusterId: string, plan: string) => {
      setupCalls.push({ clusterId, plan });
    };

    await (doctor as any).allocateForPlan("cluster-indie", "indie-cluster", "indie");

    assert.deepEqual(setupCalls, [{ clusterId: "cluster-indie", plan: "indie" }]);
  });

  it("does NOT fire sendSetupClusterTask for a pro cluster", async () => {
    const setupCalls: string[] = [];
    const db = {
      instances: { releasePoolInstance: async () => {} },
    } as any;
    const pool = {
      allocateSharedPool: async () => { throw new Error("must not allocate pro to shared pool"); },
      spawnDedicatedInstance: async () => {},
    };

    const doctor = makeDoctor({ db, pool });
    (doctor as any).sendSetupClusterTask = async (clusterId: string) => {
      setupCalls.push(clusterId);
    };

    await (doctor as any).allocateForPlan("cluster-pro", "pro-cluster", "pro");

    assert.deepEqual(setupCalls, [], "must not fire setup task for pro tier");
  });
});
