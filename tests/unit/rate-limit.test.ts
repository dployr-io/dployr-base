// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { rateLimit } from "@/middleware/ratelimit.js";
import { MemoryKV } from "@/lib/storage/kv.interface.js";

function buildApp(kv: MemoryKV, maxRequests: number, userId?: string) {
  const app = new Hono() as any;
  app.use("*", async (c: any, next: any) => {
    c.set("kvAdapter", kv);
    if (userId) c.set("session", { userId });
    await next();
  });
  app.use("*", rateLimit({ windowMs: 60_000, maxRequests, keyPrefix: "test" }));
  app.get("/ping", (c: any) => c.json({ ok: true }));
  return app as Hono;
}

async function ping(app: Hono) {
  return app.fetch(new Request("http://localhost/ping"));
}

describe("rateLimit middleware", () => {
  it("allows requests under the limit", async () => {
    const app = buildApp(new MemoryKV(), 3, "user-a");
    const res = await ping(app);
    assert.equal(res.status, 200);
  });

  it("sets X-RateLimit-Limit and X-RateLimit-Remaining headers on allowed requests", async () => {
    const app = buildApp(new MemoryKV(), 3, "user-b");
    const res = await ping(app);
    assert.equal(res.headers.get("x-ratelimit-limit"), "3");
    assert.equal(res.headers.get("x-ratelimit-remaining"), "2");
  });

  it("decrements X-RateLimit-Remaining on each request", async () => {
    const kv = new MemoryKV();
    const app = buildApp(kv, 3, "user-c");
    await ping(app);
    const res = await ping(app);
    assert.equal(res.headers.get("x-ratelimit-remaining"), "1");
  });

  it("returns 429 once the limit is exceeded", async () => {
    const kv = new MemoryKV();
    const app = buildApp(kv, 3, "user-d");
    for (let i = 0; i < 3; i++) await ping(app);
    const res = await ping(app);
    assert.equal(res.status, 429);
  });

  it("429 response includes Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining headers", async () => {
    const kv = new MemoryKV();
    const app = buildApp(kv, 2, "user-e");
    await ping(app);
    await ping(app);
    const res = await ping(app);
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"), "Retry-After must be present");
    assert.equal(res.headers.get("x-ratelimit-limit"), "2");
    assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
  });

  it("buckets are isolated per user", async () => {
    const kv = new MemoryKV();
    const appA = buildApp(kv, 2, "user-f");
    const appB = buildApp(kv, 2, "user-g");
    await ping(appA);
    await ping(appA);
    // user-f is now at limit; user-g has a clean bucket
    const res = await ping(appB);
    assert.equal(res.status, 200);
  });

  it("falls through to the handler when KV throws (fail-open)", async () => {
    const badKv = {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
      delete: async () => { throw new Error("kv down"); },
      list: async () => { throw new Error("kv down"); },
      incr: async () => { throw new Error("kv down"); },
    } as any;
    const app = buildApp(badKv, 3, "user-h");
    const res = await ping(app);
    assert.equal(res.status, 200);
  });
});
