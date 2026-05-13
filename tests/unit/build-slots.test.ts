// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "@/lib/storage/kv.interface.js";
import { InstanceCacheStore } from "@/lib/db/store/kv/instance-cache.js";

function makeStore() {
  return new InstanceCacheStore(new MemoryKV());
}

describe("InstanceCacheStore — build slots", () => {
  it("getBuildSlots returns 0 for an unknown node", async () => {
    const store = makeStore();
    assert.equal(await store.getBuildSlots("build-node-1"), 0);
  });

  it("incrementBuildSlots starts at 1 from zero", async () => {
    const store = makeStore();
    const count = await store.incrementBuildSlots("build-node-1");
    assert.equal(count, 1);
  });

  it("incrementBuildSlots accumulates across calls", async () => {
    const store = makeStore();
    await store.incrementBuildSlots("node-a");
    await store.incrementBuildSlots("node-a");
    const count = await store.incrementBuildSlots("node-a");
    assert.equal(count, 3);
    assert.equal(await store.getBuildSlots("node-a"), 3);
  });

  it("slot counters are isolated per node tag", async () => {
    const store = makeStore();
    await store.incrementBuildSlots("node-a");
    await store.incrementBuildSlots("node-a");
    await store.incrementBuildSlots("node-b");

    assert.equal(await store.getBuildSlots("node-a"), 2);
    assert.equal(await store.getBuildSlots("node-b"), 1);
  });

  it("decrementBuildSlots reduces the count", async () => {
    const store = makeStore();
    await store.incrementBuildSlots("node-1");
    await store.incrementBuildSlots("node-1");
    const after = await store.decrementBuildSlots("node-1");
    assert.equal(after, 1);
    assert.equal(await store.getBuildSlots("node-1"), 1);
  });

  it("decrementBuildSlots never goes below zero", async () => {
    const store = makeStore();
    const result = await store.decrementBuildSlots("node-1");
    assert.equal(result, 0);
    assert.equal(await store.getBuildSlots("node-1"), 0);
  });

  it("decrement to zero clears the key — subsequent getBuildSlots returns 0", async () => {
    const store = makeStore();
    await store.incrementBuildSlots("node-1");
    await store.decrementBuildSlots("node-1");

    // Key should be gone; getBuildSlots must still return 0 cleanly
    assert.equal(await store.getBuildSlots("node-1"), 0);
  });

  it("full slot lifecycle: fill to max, drain, verify zero", async () => {
    const store = makeStore();
    const node = "build-node";
    const maxSlots = 4;

    for (let i = 0; i < maxSlots; i++) {
      await store.incrementBuildSlots(node);
    }
    assert.equal(await store.getBuildSlots(node), maxSlots);

    for (let i = 0; i < maxSlots; i++) {
      await store.decrementBuildSlots(node);
    }
    assert.equal(await store.getBuildSlots(node), 0);
  });
});
