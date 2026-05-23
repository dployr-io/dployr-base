// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import status from "@/routes/status.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { MemoryKV } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { SERVICE_WAKING_TTL } from "@/lib/constants/duration.js";

const TLD = "dployr.run";
const FAKE_ENV = { TRAEFIK_TLD: TLD, BASE_URL: "https://base.dployr.io" };

function makeDbStore(opts: {
  serviceName: string;
  clusterId: string;
  routingKey: string | null;
}) {
  return {
    domains: { find: async (_domain: string) => null },
    services: {
      find: async (filter: any) =>
        filter.name === opts.serviceName
          ? { id: "svc-1", name: opts.serviceName, clusterId: opts.clusterId }
          : null,
      list: async () => ({ services: [] }),
    },
    instances: {
      getRoutingKey: async (_clusterId: string) => opts.routingKey,
    },
  };
}

function makeConnectionManager(connectedKeys: string[]) {
  const dispatched: string[] = [];
  return {
    dispatched,
    sendTask: (key: string, _task: any) => {
      if (connectedKeys.includes(key)) { dispatched.push(key); return true; }
      return false;
    },
  };
}

function buildApp(dbStore: ReturnType<typeof makeDbStore>, kvStore: KVStore, cm: ReturnType<typeof makeConnectionManager>) {
  const app = new Hono() as any;
  app.use("*", async (c: any, next: any) => {
    c.set("_dbStore", dbStore);
    c.set("_kvStore", kvStore);
    c.set("wsHandler", { connectionManager: cm });
    await next();
  });
  app.route("/", status);
  return app as Hono;
}

async function get(app: Hono, domain: string) {
  const res = await app.fetch(
    new Request(`http://localhost/?domain=${encodeURIComponent(domain)}`),
    FAKE_ENV,
  );
  return { status: res.status, body: await res.json() as { status: string } };
}

describe("GET /v1/status — loading page state machine", () => {
  it("returns 'starting' while WAKING flag is set (container is booting)", async () => {
    const kv = new KVStore(new MemoryKV());
    await kv.kv.put(KV_KEYS.SERVICE.WAKING("api"), "1", { ttl: SERVICE_WAKING_TTL });

    const cm = makeConnectionManager(["node-1"]);
    const app = buildApp(makeDbStore({ serviceName: "api", clusterId: "c1", routingKey: "node-1" }), kv, cm);

    const res = await get(app, `api.${TLD}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "starting");
    assert.equal(cm.dispatched.length, 0, "must not re-fire wake task while already waking");
  });

  it("returns 'ready' when neither SLEEPING nor WAKING is set (service is running)", async () => {
    const kv = new KVStore(new MemoryKV());
    const cm = makeConnectionManager(["node-1"]);
    const app = buildApp(makeDbStore({ serviceName: "api", clusterId: "c1", routingKey: "node-1" }), kv, cm);

    const res = await get(app, `api.${TLD}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ready");
  });

  it("returns 'ready' when WAKING TTL has expired — Traefik may still be on the stub; loading page must not reload on this signal alone", async () => {
    // Both flags absent = the race that caused the infinite redirect loop.
    // The status route correctly returns "ready" here — the fix lives in loading.html,
    // which now only reloads on the X-Dployr-Loading HEAD check, not on this signal.
    const kv = new KVStore(new MemoryKV()); // no flags set
    const cm = makeConnectionManager(["node-1"]);
    const app = buildApp(makeDbStore({ serviceName: "api", clusterId: "c1", routingKey: "node-1" }), kv, cm);

    const res = await get(app, `api.${TLD}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ready");
    assert.equal(cm.dispatched.length, 0);
  });

  it("fires wake task and transitions SLEEPING→WAKING on first poll when node is reachable", async () => {
    const kv = new KVStore(new MemoryKV());
    await kv.kv.put(KV_KEYS.SERVICE.SLEEPING("api"), "1");

    const cm = makeConnectionManager(["node-1"]);
    const app = buildApp(makeDbStore({ serviceName: "api", clusterId: "c1", routingKey: "node-1" }), kv, cm);

    const res = await get(app, `api.${TLD}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "starting");

    assert.equal(cm.dispatched.length, 1, "wake task dispatched");
    assert.equal(await kv.kv.get(KV_KEYS.SERVICE.SLEEPING("api")), null, "SLEEPING cleared");
    assert.equal(await kv.kv.get(KV_KEYS.SERVICE.WAKING("api")), "1", "WAKING set");
  });

  it("returns 'starting' without modifying flags when node is unreachable", async () => {
    const kv = new KVStore(new MemoryKV());
    await kv.kv.put(KV_KEYS.SERVICE.SLEEPING("api"), "1");

    const cm = makeConnectionManager([]); // no connected nodes
    const app = buildApp(makeDbStore({ serviceName: "api", clusterId: "c1", routingKey: "node-1" }), kv, cm);

    const res = await get(app, `api.${TLD}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "starting");
    assert.equal(cm.dispatched.length, 0);
    assert.equal(await kv.kv.get(KV_KEYS.SERVICE.SLEEPING("api")), "1", "SLEEPING untouched");
    assert.equal(await kv.kv.get(KV_KEYS.SERVICE.WAKING("api")), null, "WAKING not set");
  });

  it("returns 404/not_found for unknown service name", async () => {
    const kv = new KVStore(new MemoryKV());
    const cm = makeConnectionManager(["node-1"]);
    const app = buildApp(makeDbStore({ serviceName: "api", clusterId: "c1", routingKey: "node-1" }), kv, cm);

    const res = await get(app, `unknown.${TLD}`);
    assert.equal(res.body.status, "not_found");
  });

  it("does not re-fire wake task on repeated polls while WAKING is set", async () => {
    const kv = new KVStore(new MemoryKV());
    await kv.kv.put(KV_KEYS.SERVICE.WAKING("api"), "1", { ttl: SERVICE_WAKING_TTL });

    const cm = makeConnectionManager(["node-1"]);
    const app = buildApp(makeDbStore({ serviceName: "api", clusterId: "c1", routingKey: "node-1" }), kv, cm);

    for (let i = 0; i < 5; i++) {
      const res = await get(app, `api.${TLD}`);
      assert.equal(res.body.status, "starting");
    }
    assert.equal(cm.dispatched.length, 0, "wake task must never fire while WAKING is already set");
  });
});
