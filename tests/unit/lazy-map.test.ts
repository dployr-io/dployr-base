// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LazyMap } from "@/lib/lazy-map.js";

describe("LazyMap", () => {
  it("stores and retrieves a value before TTL", () => {
    const map = new LazyMap<string, number>(5_000);
    map.set("k", 42);
    assert.equal(map.get("k"), 42);
  });

  it("returns undefined for missing key", () => {
    const map = new LazyMap<string, string>(5_000);
    assert.equal(map.get("missing"), undefined);
  });

  it("expires entries after TTL", async () => {
    const map = new LazyMap<string, string>(50); // 50 ms TTL
    map.set("k", "v");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(map.get("k"), undefined);
  });

  it("has() returns false for expired entries", async () => {
    const map = new LazyMap<string, string>(50);
    map.set("k", "v");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(map.has("k"), false);
  });

  it("has() returns true for live entries", () => {
    const map = new LazyMap<string, string>(5_000);
    map.set("k", "v");
    assert.equal(map.has("k"), true);
  });

  it("delete removes an entry", () => {
    const map = new LazyMap<string, string>(5_000);
    map.set("k", "v");
    assert.equal(map.delete("k"), true);
    assert.equal(map.get("k"), undefined);
  });

  it("delete returns false for missing key", () => {
    const map = new LazyMap<string, string>(5_000);
    assert.equal(map.delete("nope"), false);
  });

  it("size reflects only live entries", async () => {
    const map = new LazyMap<string, string>(50);
    map.set("a", "1");
    map.set("b", "2");
    assert.equal(map.size, 2);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(map.size, 0);
  });

  it("entries() yields only live entries", async () => {
    const map = new LazyMap<string, string>(50);
    map.set("dead", "x");
    await new Promise((r) => setTimeout(r, 80));
    map.set("alive", "y");
    const keys = Array.from(map.entries()).map(([k]) => k);
    assert.deepEqual(keys, ["alive"]);
  });

  it("clear() removes all entries", () => {
    const map = new LazyMap<string, number>(5_000);
    map.set("a", 1);
    map.set("b", 2);
    map.clear();
    assert.equal(map.size, 0);
  });
});
