// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthService } from "@/services/auth/index.js";

function makeEnv() {
  return {} as any;
}

function makeKv() {
  return {} as any;
}

function makeDb({
  cluster = { id: "cluster-1", poolInstanceId: null } as any,
  dedicated = null as any,
  assignPoolCalls = [] as string[],
  assignPoolReturns = "pool-inst-1",
} = {}) {
  return {
    clusters: {
      async upsert() { return cluster; },
    },
    instances: {
      async find({ kind }: any) {
        if (kind === "dedicated") return dedicated;
        return null;
      },
      async assignPool(clusterId: string) {
        assignPoolCalls.push(clusterId);
        return assignPoolReturns;
      },
    },
  } as any;
}

describe("AuthService.provisionCluster — pool assignment guard", () => {
  it("assigns hobby pool when cluster has no pool instance and no dedicated instance", async () => {
    const assigned: string[] = [];
    const db = makeDb({ assignPoolCalls: assigned, assignPoolReturns: "pool-inst-1" });
    const svc = new AuthService(db, makeKv(), makeEnv());

    const result = await svc.provisionCluster({ userId: "user-1" });

    assert.deepEqual(assigned, ["cluster-1"], "must assign new cluster to pool");
    assert.equal(result?.id, "cluster-1");
    assert.equal(result?.poolInstanceId, "pool-inst-1", "must return the freshly assigned poolInstanceId");
  });

  it("skips pool assignment when cluster already has a poolInstanceId", async () => {
    const assigned: string[] = [];
    const cluster = { id: "cluster-1", poolInstanceId: "pool-inst-99" };
    const db = makeDb({ cluster, assignPoolCalls: assigned });
    const svc = new AuthService(db, makeKv(), makeEnv());

    const result = await svc.provisionCluster({ userId: "user-1" });

    assert.deepEqual(assigned, [], "must not re-assign a cluster that already has a pool instance");
    assert.equal(result?.poolInstanceId, undefined, "must not expose poolInstanceId when cluster was already assigned");
  });

  it("skips pool assignment when cluster has a dedicated instance (pro tier)", async () => {
    const assigned: string[] = [];
    const dedicated = { id: "inst-pro-1", tag: "dployr-pro-abc", kind: "dedicated" };
    const db = makeDb({ dedicated, assignPoolCalls: assigned });
    const svc = new AuthService(db, makeKv(), makeEnv());

    await svc.provisionCluster({ userId: "user-1" });

    assert.deepEqual(assigned, [], "must not assign pro cluster to shared pool on login");
  });

  it("returns null when cluster upsert fails", async () => {
    const db = {
      clusters: { async upsert() { throw new Error("db error"); } },
      instances: { async find() { return null; }, async assignPool() {} },
    } as any;
    const svc = new AuthService(db, makeKv(), makeEnv());

    const result = await svc.provisionCluster({ userId: "user-1" });

    assert.equal(result, null, "must return null on upsert failure");
  });
});
