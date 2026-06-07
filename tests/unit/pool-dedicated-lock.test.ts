// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InstancePool } from "@/services/pool.js";

function makeKv() {
  const store = new Map<string, number>();
  return {
    kv: {
      async incr(key: string, _ttl: number) {
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      },
      async delete(key: string) {
        store.delete(key);
      },
    },
  } as any;
}

function makeDb() {
  const created: string[] = [];
  return {
    db: {
      clusters: { async find() { return { name: "test-cluster" }; } },
      instances: {
        async create({ clusterId }: { clusterId: string }) {
          created.push(clusterId);
          return { id: "inst-1" };
        },
      },
      bootstrapTokens: { async create() {} },
    } as any,
    created,
  };
}

function makeVm(failCreate = false) {
  const spawned: string[] = [];
  return {
    vm: {
      async list() { return []; },
      async create(opts: any) {
        if (failCreate) throw new Error("VM provider failure");
        spawned.push(opts.name ?? "vm");
        return { ipv4: "1.2.3.4", region: "nyc3" };
      },
    } as any,
    spawned,
  };
}

function makeJwt() {
  return {
    jwt: {
      async createBootstrapToken(_tag: string) { return "tok"; },
      async verifyToken(_tok: string) { return { nonce: "nonce-1" }; },
    } as any,
  };
}

function makePool(kv: any, db: any, vm: any, jwt: any) {
  return new InstancePool({ db, kv, vm, jwt, registry: {} });
}

describe("InstancePool.spawnDedicatedInstance — per-cluster KV lock", () => {
  it("provisions a dedicated instance on first call", async () => {
    const kv = makeKv();
    const { db, created } = makeDb();
    const { vm } = makeVm(false);
    const { jwt } = makeJwt();
    const pool = makePool(kv, db, vm, jwt);

    await pool.spawnDedicatedInstance({ clusterId: "cluster-1", clusterName: "test" });

    assert.equal(created.length, 1, "should create exactly one instance record");
    assert.equal(created[0], "cluster-1");
  });

  it("skips provisioning when lock is already held (concurrent call)", async () => {
    const kv = makeKv();
    const { db, created } = makeDb();
    const { vm } = makeVm(false);
    const { jwt } = makeJwt();
    const pool = makePool(kv, db, vm, jwt);

    // Simulate lock already held by a concurrent caller
    await kv.kv.incr(`cluster:cluster-1:dedicated:provisioning`, 600);

    await pool.spawnDedicatedInstance({ clusterId: "cluster-1", clusterName: "test" });

    assert.equal(created.length, 0, "should skip provisioning when lock is held");
  });

  it("clears the lock on provisioning error so the next call can retry", async () => {
    const kv = makeKv();
    const store = (kv as any).kv;
    const { db } = makeDb();
    const { jwt } = makeJwt();
    const { vm: failingVm } = makeVm(true);

    const pool = makePool(kv, db, failingVm, jwt);

    await assert.rejects(
      () => pool.spawnDedicatedInstance({ clusterId: "cluster-1", clusterName: "test" }),
      /VM provider failure/,
    );

    // Lock must be cleared so a retry attempt can acquire it
    const lockAfterError = await store.incr(`cluster:cluster-1:dedicated:provisioning`, 600);
    assert.equal(lockAfterError, 1, "lock should be cleared after error so retry can acquire it");
  });
});
