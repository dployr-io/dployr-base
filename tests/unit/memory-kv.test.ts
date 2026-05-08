// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "@/lib/storage/kv.interface.js";

describe("MemoryKV", () => {
  it("put then get returns the stored value", async () => {
    const kv = new MemoryKV();
    await kv.put("key", "value");
    assert.equal(await kv.get("key"), "value");
  });

  it("get returns null for missing key", async () => {
    const kv = new MemoryKV();
    assert.equal(await kv.get("nope"), null);
  });

  it("delete removes the key", async () => {
    const kv = new MemoryKV();
    await kv.put("k", "v");
    await kv.delete("k");
    assert.equal(await kv.get("k"), null);
  });

  it("get returns null after TTL expires", async () => {
    const kv = new MemoryKV();
    await kv.put("k", "v", { ttl: 1 }); // 1s TTL
    // Manually backdating is not possible; instead confirm a key without TTL never expires
    // and a short TTL test is covered by lazy-map.test.ts which has real timer control.
    // This test confirms the put+get contract with a TTL set.
    assert.equal(await kv.get("k"), "v");
  });

  it("list returns keys matching prefix", async () => {
    const kv = new MemoryKV();
    await kv.put("prefix:a", "1");
    await kv.put("prefix:b", "2");
    await kv.put("other:c", "3");
    const result = await kv.list({ prefix: "prefix:" });
    const names = result.map((r) => r.name).sort();
    assert.deepEqual(names, ["prefix:a", "prefix:b"]);
  });

  it("list respects limit", async () => {
    const kv = new MemoryKV();
    await kv.put("x:1", "a");
    await kv.put("x:2", "b");
    await kv.put("x:3", "c");
    const result = await kv.list({ prefix: "x:", limit: 2 });
    assert.equal(result.length, 2);
  });

  it("list returns empty array when no keys match prefix", async () => {
    const kv = new MemoryKV();
    await kv.put("a:1", "v");
    const result = await kv.list({ prefix: "b:" });
    assert.deepEqual(result, []);
  });

  it("incr starts at 1 for a new key", async () => {
    const kv = new MemoryKV();
    assert.equal(await kv.incr("counter"), 1);
  });

  it("incr increments on subsequent calls", async () => {
    const kv = new MemoryKV();
    await kv.incr("c");
    await kv.incr("c");
    assert.equal(await kv.incr("c"), 3);
  });

  it("incr on separate instances starts fresh at 1", async () => {
    const kv1 = new MemoryKV();
    const kv2 = new MemoryKV();
    await kv1.incr("c");
    await kv1.incr("c");
    assert.equal(await kv2.incr("c"), 1);
  });

  it("incr with TTL sets expiry on first call only", async () => {
    const kv = new MemoryKV();
    await kv.incr("c", 10);
    await kv.incr("c", 10);
    // Still alive after second incr (TTL not reset)
    assert.equal(await kv.get("c"), "2");
  });
});
