// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeDoctor } from "@/lib/node/node-doctor.js";
import type { Instance, InstanceStatus } from "@/types/index.js";

function makeBuildNode(tag: string, status: InstanceStatus): Partial<Instance> {
  return { id: `id-${tag}`, tag, status, role: "build" as any };
}

function makeDb(buildNodes: Partial<Instance>[]) {
  return {
    instances: {
      list: async () => ({ instances: buildNodes }),
    },
  } as any;
}

function makeKv() {
  return {
    instanceCache: {
      getInFlightBuilds: async () => [],
    },
    payloads: {
      enqueueBuild: async () => {},
    },
    kv: {
      delete: async () => {},
    },
  } as any;
}

function makePool() {
  let spawnCount = 0;
  return {
    pool: {
      spawnBuildNode: async () => { spawnCount++; },
    },
    getSpawnCount: () => spawnCount,
  };
}

function makeDoctor(buildNodes: Partial<Instance>[], desiredBuildNodeCapacity: number) {
  const { pool, getSpawnCount } = makePool();
  const doctor = new NodeDoctor({
    db: makeDb(buildNodes),
    kv: makeKv(),
    vm: null,
    conn: { emit: async () => {} } as any,
    pool: pool as any,
    desiredBuildNodeCapacity,
  });
  return { doctor, getSpawnCount };
}

describe("NodeDoctor.buildNodeReconcile — capacity enforcement", () => {
  it("does not spawn when a provisioning node already covers the desired count", async () => {
    const { doctor, getSpawnCount } = makeDoctor(
      [makeBuildNode("build-1", "provisioning")],
      1,
    );
    await doctor.buildNodeReconcile();
    assert.equal(getSpawnCount(), 0, "should not spawn while a node is still provisioning");
  });

  it("does not spawn when desired count is already healthy", async () => {
    const { doctor, getSpawnCount } = makeDoctor(
      [makeBuildNode("build-1", "healthy")],
      1,
    );
    await doctor.buildNodeReconcile();
    assert.equal(getSpawnCount(), 0);
  });

  it("spawns exactly the deficit when no active nodes exist", async () => {
    const { doctor, getSpawnCount } = makeDoctor([], 2);
    await doctor.buildNodeReconcile();
    assert.equal(getSpawnCount(), 2);
  });

  it("spawns only the remaining deficit when one of two desired is provisioning", async () => {
    const { doctor, getSpawnCount } = makeDoctor(
      [makeBuildNode("build-1", "provisioning")],
      2,
    );
    await doctor.buildNodeReconcile();
    assert.equal(getSpawnCount(), 1, "only one node needed — the other is already in-flight");
  });

  it("does not count degraded nodes toward active capacity", async () => {
    const { doctor, getSpawnCount } = makeDoctor(
      [makeBuildNode("build-1", "degraded")],
      1,
    );
    await doctor.buildNodeReconcile();
    assert.equal(getSpawnCount(), 1, "degraded node should not count — a replacement must be spawned");
  });

  it("does not count offline nodes toward active capacity", async () => {
    const { doctor, getSpawnCount } = makeDoctor(
      [makeBuildNode("build-1", "offline")],
      1,
    );
    await doctor.buildNodeReconcile();
    assert.equal(getSpawnCount(), 1);
  });

  it("counts both healthy and provisioning nodes together against desired", async () => {
    const { doctor, getSpawnCount } = makeDoctor(
      [makeBuildNode("build-1", "healthy"), makeBuildNode("build-2", "provisioning")],
      2,
    );
    await doctor.buildNodeReconcile();
    assert.equal(getSpawnCount(), 0, "one healthy + one provisioning satisfies desired=2");
  });
});
