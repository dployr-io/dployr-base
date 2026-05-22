// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraefikService } from "@/services/traefik-router.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { SERVICE_STUB_ADDRESS } from "@/lib/constants/index.js";

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); },
    del: async (key: string) => { store.delete(key); },
    store,
  };
}

function makeTraefik(redis: ReturnType<typeof makeRedis>) {
  return new TraefikService("dployr.run", redis as any);
}

const WAKEUP_MIDDLEWARE = "hobby-wakeup";

describe("TraefikService.ensureWakeupMiddleware", () => {
  it("writes indexed status keys — flat string would silently break Traefik v3 KV matching", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).ensureWakeupMiddleware();

    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE, 0)), "502");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE, 1)), "503");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE, 2)), "504");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_SERVICE(WAKEUP_MIDDLEWARE)), "loading-stub@redis");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_QUERY(WAKEUP_MIDDLEWARE)), "/");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.SERVICE_URL("loading-stub")), SERVICE_STUB_ADDRESS);
  });

  it("is idempotent — safe to call multiple times", async () => {
    const redis = makeRedis();
    const svc = makeTraefik(redis);
    await svc.ensureWakeupMiddleware();
    await svc.ensureWakeupMiddleware();
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE, 0)), "502");
  });
});

describe("TraefikService.setLoadingMode", () => {
  it("points service URL at stub address", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).setLoadingMode("ronaldo");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.SERVICE_URL("ronaldo")), SERVICE_STUB_ADDRESS);
  });

  it("attaches wakeup middleware to the router — critical for 502 intercept", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).setLoadingMode("ronaldo");
    assert.equal(
      redis.store.get(KV_KEYS.TRAEFIK.ROUTER_MIDDLEWARE("ronaldo", 0)),
      WAKEUP_MIDDLEWARE,
      "middleware must be attached to the router or Traefik forwards raw 502 to Cloudflare",
    );
  });

  it("writes middleware definition keys as part of setLoadingMode", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).setLoadingMode("api");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE, 0)), "502");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE, 1)), "503");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE, 2)), "504");
  });
});

describe("TraefikService.registerRoute", () => {
  it("writes rule, entrypoints, service, and backend URL", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).registerRoute({ serviceName: "api", instanceAddress: "10.0.0.1", instancePort: 3000 });

    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_RULE("api")), "Host(`api.dployr.run`)");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS("api")), "websecure");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_SERVICE("api")), "api");
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.SERVICE_URL("api")), "http://10.0.0.1:3000");
  });

  it("does NOT attach wakeup middleware for non-hobby routes", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).registerRoute({ serviceName: "api", instanceAddress: "10.0.0.1", hobby: false });
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_MIDDLEWARE("api", 0)), undefined);
  });

  it("attaches wakeup middleware for hobby routes", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).registerRoute({ serviceName: "api", instanceAddress: "10.0.0.1", hobby: true });
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_MIDDLEWARE("api", 0)), WAKEUP_MIDDLEWARE);
  });

  it("defaults to port 80", async () => {
    const redis = makeRedis();
    await makeTraefik(redis).registerRoute({ serviceName: "api", instanceAddress: "10.0.0.2" });
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.SERVICE_URL("api")), "http://10.0.0.2:80");
  });
});

describe("TraefikService.unregisterRoute", () => {
  it("removes all route keys", async () => {
    const redis = makeRedis();
    const svc = makeTraefik(redis);
    await svc.registerRoute({ serviceName: "api", instanceAddress: "10.0.0.1", hobby: true });
    await svc.unregisterRoute("api");

    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_RULE("api")), undefined);
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS("api")), undefined);
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_SERVICE("api")), undefined);
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.SERVICE_URL("api")), undefined);
    assert.equal(redis.store.get(KV_KEYS.TRAEFIK.ROUTER_MIDDLEWARE("api", 0)), undefined);
  });
});

describe("TraefikService.getRouteBackendUrl", () => {
  it("returns null when service is not registered", async () => {
    const redis = makeRedis();
    const result = await makeTraefik(redis).getRouteBackendUrl("unknown");
    assert.equal(result, null);
  });

  it("returns the backend URL after registerRoute", async () => {
    const redis = makeRedis();
    const svc = makeTraefik(redis);
    await svc.registerRoute({ serviceName: "api", instanceAddress: "10.0.0.5", instancePort: 8080 });
    assert.equal(await svc.getRouteBackendUrl("api"), "http://10.0.0.5:8080");
  });

  it("returns stub address after setLoadingMode", async () => {
    const redis = makeRedis();
    const svc = makeTraefik(redis);
    await svc.registerRoute({ serviceName: "api", instanceAddress: "10.0.0.5" });
    await svc.setLoadingMode("api");
    assert.equal(await svc.getRouteBackendUrl("api"), SERVICE_STUB_ADDRESS);
  });
});
