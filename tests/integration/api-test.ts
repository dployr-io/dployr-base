// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupFixtures, type TestFixtures } from "./fixtures.js";


let fx: TestFixtures;
let BASE_URL: string;

const created = {
  instanceIds: [] as string[],
  domainNames: [] as string[],
};

before(async () => {
  BASE_URL = process.env.BASE_URL ?? "http://localhost:7878";
  fx = await setupFixtures();
  console.log("[test] Fixtures ready");
});

after(async () => {
  await cleanupCreated();
  await fx.cleanup();
  console.log("[test] Cleanup done");
});

function get(path: string) {
  return fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: fx.session },
  });
}

function post(path: string, body: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: fx.session },
    body: JSON.stringify(body),
  });
}

function del(path: string) {
  return fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { Cookie: fx.session },
  });
}

function patch(path: string, body: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: fx.session },
    body: JSON.stringify(body),
  });
}

// Unauthenticated
function pub(path: string, init: RequestInit = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...((init.headers as object) ?? {}) },
  });
}

function assertOk(res: Response, body: any, status = 200) {
  assert.equal(res.status, status, `Expected ${status}, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.success, true);
}

function assertFail(res: Response, body: any, status: number) {
  assert.equal(res.status, status, `Expected ${status}, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.success, false);
  assert.ok(body.error?.code, "Expected error.code");
}

async function cleanupCreated() {
  for (const id of created.instanceIds) {
    try { await del(`/v1/instances/${id}`); } catch {}
  }
  for (const d of created.domainNames) {
    try { await del(`/v1/domains/${d}`); } catch {}
  }
}

function trackInstance(id: string) { created.instanceIds.push(id); }
function trackDomain(d: string) { created.domainNames.push(d); }

function randomOctet() { return Math.floor(Math.random() * 200) + 10; }


describe("Health", () => {
  it("GET /v1/health returns ok", async () => {
    const res = await pub("/v1/health");
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.status, "ok");
    assert.ok(body.version);
  });

  it("GET /v1/ws/stats returns stats or 503", async () => {
    const res = await pub("/v1/ws/stats");
    assert.ok([200, 503].includes(res.status));
    if (res.status === 200) {
      const body = await res.json() as any;
      assert.equal(body.success, true);
      assert.ok(typeof body.data.totalConnections === "number");
    }
  });
});


describe("JWKS", () => {
  it("returns a keys array", async () => {
    const res = await pub("/v1/jwks/.well-known/jwks.json");
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.ok(Array.isArray(body.keys));
    if (body.keys.length > 0) {
      assert.ok(body.keys[0].kty);
      assert.ok(body.keys[0].kid);
    }
  });
});


describe("Auth", () => {
  it("POST /v1/auth/login/email rejects missing email", async () => {
    const res = await pub("/v1/auth/login/email", { method: "POST", body: JSON.stringify({}) });
    assert.equal(res.status, 400);
  });

  it("GET /v1/users/me rejects unauthenticated", async () => {
    const res = await pub("/v1/users/me");
    assert.equal(res.status, 401);
    const body = await res.json() as any;
    assert.equal(body.error.code, "auth.bad_session");
  });

  it("OAuth login redirects for valid provider", async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/login/github`, { redirect: "manual" });
    assert.equal(res.status, 302);
  });
});


describe("Users", () => {
  it("GET /v1/users/me returns user and clusters", async () => {
    const res = await get("/v1/users/me");
    const body = await res.json() as any;
    assertOk(res, body);
    assert.ok(body.data.user.id);
    assert.ok(body.data.user.email);
    assert.ok(Array.isArray(body.data.clusters));
  });

  it("PATCH /v1/users/me rejects name too short", async () => {
    const res = await patch("/v1/users/me", { name: "ab" });
    assert.equal(res.status, 400);
  });

  it("PATCH /v1/users/me updates name", async () => {
    const res = await patch("/v1/users/me", { name: "CI Test User" });
    const body = await res.json() as any;
    assertOk(res, body);
    assert.equal(body.data.user.name, "CI Test User");
  });
});


describe("Clusters", () => {
  it("GET /v1/clusters contains the test cluster", async () => {
    const res = await get("/v1/clusters");
    const body = await res.json() as any;
    assertOk(res, body);
    const ids = body.data.clusters.map((c: any) => c.id);
    assert.ok(ids.includes(fx.clusterId), `Test cluster ${fx.clusterId} not in list`);
  });

  it("GET /v1/clusters/users/invites returns array", async () => {
    const res = await get("/v1/clusters/users/invites");
    const body = await res.json() as any;
    assertOk(res, body);
    assert.ok(Array.isArray(body.data.invites));
  });

  it("GET /v1/clusters/:id/users returns paginated members", async () => {
    const res = await get(`/v1/clusters/${fx.clusterId}/users`);
    const body = await res.json() as any;
    assertOk(res, body);
    assert.ok(body.data.pagination);
    assert.ok(Array.isArray(body.data.items));
  });

  it("POST /v1/clusters/:id/users rejects invalid emails", async () => {
    const res = await post(`/v1/clusters/${fx.clusterId}/users`, { users: ["not-an-email"] });
    assert.ok([400, 403].includes(res.status));
  });

  it("GET /v1/clusters/:id/integrations returns integration map", async () => {
    const res = await get(`/v1/clusters/${fx.clusterId}/integrations`);
    const body = await res.json() as any;
    assertOk(res, body);
  });
});


describe("Instances", () => {
  let instanceId: string;

  it("GET /v1/instances returns paginated list", async () => {
    const res = await get(`/v1/instances?clusterId=${fx.clusterId}`);
    const body = await res.json() as any;
    assertOk(res, body);
    assert.ok(body.data.pagination);
  });

  it("POST /v1/instances rejects missing fields", async () => {
    const res = await post("/v1/instances", { address: "1.2.3.4" });
    assert.equal(res.status, 400);
  });

  it("POST /v1/instances rejects tag too short", async () => {
    const res = await post("/v1/instances", {
      clusterId: fx.clusterId,
      address: "10.0.0.1",
      tag: "ab",
    });
    assert.equal(res.status, 400);
  });

  it("POST /v1/instances creates instance with bootstrap token", async () => {
    const tag = `ci-${Date.now().toString(36)}`;
    const res = await post("/v1/instances", {
      clusterId: fx.clusterId,
      address: `10.${randomOctet()}.${randomOctet()}.${randomOctet()}`,
      tag,
    });
    const body = await res.json() as any;

    if (res.status === 200) {
      assertOk(res, body);
      assert.ok(body.data.instance.id);
      assert.ok(body.data.token, "Must return bootstrap token");
      instanceId = body.data.instance.id;
      trackInstance(instanceId);
    } else {
      // Plan limit or permissions — acceptable in test env
      assert.ok([400, 403, 409].includes(res.status));
    }
  });

  it("GET /v1/instances/:id returns instance", async () => {
    if (!instanceId) return;
    const res = await get(`/v1/instances/${instanceId}`);
    const body = await res.json() as any;
    assertOk(res, body);
    assert.equal(body.data.id, instanceId);
  });

  it("GET /v1/instances/:id returns error for unknown id", async () => {
    const res = await get("/v1/instances/00000000000000000000000000");
    assert.ok([400, 404].includes(res.status));
  });

  it("DELETE /v1/instances/:id deletes instance", async () => {
    if (!instanceId) return;
    const res = await del(`/v1/instances/${instanceId}`);
    const body = await res.json() as any;
    assertOk(res, body);
    assert.equal(body.data.deleted, true);
    const idx = created.instanceIds.indexOf(instanceId);
    if (idx !== -1) created.instanceIds.splice(idx, 1);
  });

  it("GET /v1/instances/:id after deletion returns error", async () => {
    if (!instanceId) return;
    const res = await get(`/v1/instances/${instanceId}`);
    assert.ok([400, 404].includes(res.status));
  });
});


describe("Domains", () => {
  it("POST /v1/domains/register rejects invalid token", async () => {
    const res = await pub("/v1/domains/register", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.equal(body.error.code, "auth.bad_token");
  });

  it("GET /v1/domains/verify returns 400 with no domain param", async () => {
    const res = await pub("/v1/domains/verify");
    assert.equal(res.status, 400);
  });

  it("GET /v1/domains/verify returns error for unknown domain", async () => {
    const res = await pub("/v1/domains/verify?domain=not-real.example.com");
    assert.ok([403, 404].includes(res.status));
  });

  it("POST /v1/domains rejects unauthenticated", async () => {
    const res = await pub("/v1/domains", {
      method: "POST",
      body: JSON.stringify({ domain: "api.example.com", instanceId: "abc" }),
    });
    assert.ok([401, 403].includes(res.status));
  });
});


describe("Billing", () => {
  it("GET /v1/billing/plans is public", async () => {
    const res = await pub("/v1/billing/plans");
    const body = await res.json() as any;
    assertOk(res, body);
    assert.ok(Array.isArray(body.data.plans));
  });

  it("GET /v1/billing/status rejects unauthenticated", async () => {
    const res = await pub("/v1/billing/status?clusterId=x");
    assert.ok([401, 403].includes(res.status));
  });

  it("GET /v1/billing/status rejects missing clusterId", async () => {
    const res = await get("/v1/billing/status");
    assert.equal(res.status, 400);
  });

  it("GET /v1/billing/status returns subscription info", async () => {
    const res = await get(`/v1/billing/status?clusterId=${fx.clusterId}`);
    const body = await res.json() as any;
    assert.ok([200, 500].includes(res.status)); // 500 ok if billing not configured
    if (res.status === 200) assert.ok(body.data.plan);
  });
});


describe("Runtime", () => {
  it("compatibility check — today's date is compatible", async () => {
    const today = new Date().toISOString().split("T")[0];
    const res = await pub("/v1/runtime/compatibility/check", {
      method: "POST",
      body: JSON.stringify({ compatibilityDate: today, version: "v0.4.8" }),
    });
    const body = await res.json() as any;
    assertOk(res, body);
    assert.ok(typeof body.data.compatible === "boolean");
  });

  it("compatibility check — old date returns compatible:false", async () => {
    const res = await pub("/v1/runtime/compatibility/check", {
      method: "POST",
      body: JSON.stringify({ compatibilityDate: "2020-01-01", version: "v0.1.0" }),
    });
    const body = await res.json() as any;
    assertOk(res, body);
    assert.equal(body.data.compatible, false);
  });

  it("compatibility check — invalid date returns 400", async () => {
    const res = await pub("/v1/runtime/compatibility/check", {
      method: "POST",
      body: JSON.stringify({ compatibilityDate: "not-a-date" }),
    });
    assert.equal(res.status, 400);
  });

  it("GET /v1/runtime/events returns paginated events", async () => {
    const res = await get(`/v1/runtime/events?clusterId=${fx.clusterId}&pageSize=5`);
    const body = await res.json() as any;
    assertOk(res, body);
    assert.ok(body.data.pagination);
  });

  it("GET /v1/runtime/events rejects missing clusterId", async () => {
    const res = await get("/v1/runtime/events");
    assert.equal(res.status, 400);
  });
});


describe("Proxy", () => {
  it("GET /v1/proxy/stats returns router info", async () => {
    const res = await get("/v1/proxy/stats");
    const body = await res.json() as any;
    assertOk(res, body);
  });

  it("GET /v1/proxy/resolve rejects missing hostname", async () => {
    const res = await get("/v1/proxy/resolve");
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.equal(body.error.code, "validation.missing_fields");
  });

  it("GET /v1/proxy/resolve returns 404 for unknown service", async () => {
    const res = await get("/v1/proxy/resolve?hostname=nope.dployr.io");
    assert.ok([400, 404].includes(res.status));
  });

  it("GET /v1/proxy/services rejects missing clusterId", async () => {
    const res = await get("/v1/proxy/services");
    assert.equal(res.status, 400);
  });

  it("GET /v1/proxy/services returns service list", async () => {
    const res = await get(`/v1/proxy/services?clusterId=${fx.clusterId}`);
    assert.ok([200, 404].includes(res.status));
    if (res.status === 200) {
      const body = await res.json() as any;
      assert.ok(Array.isArray(body.data.services));
    }
  });

  it("POST /v1/proxy/invalidate rejects empty body", async () => {
    const res = await post("/v1/proxy/invalidate", {});
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.equal(body.error.code, "validation.missing_fields");
  });
});


describe("Integrations", () => {
  it("GET /v1/integrations/list rejects missing clusterId", async () => {
    const res = await get("/v1/integrations/list");
    assert.equal(res.status, 400);
  });

  it("GET /v1/integrations/list returns integrations", async () => {
    const res = await get(`/v1/integrations/list?clusterId=${fx.clusterId}`);
    const body = await res.json() as any;
    assertOk(res, body);
  });

  it("POST /v1/integrations/gitlab/setup rejects missing fields", async () => {
    const res = await post(`/v1/integrations/gitlab/setup?clusterId=${fx.clusterId}`, {});
    assert.ok([400, 403].includes(res.status));
  });
});


describe("Notifications", () => {
  it("POST /v1/notifications/discord/setup rejects missing clusterId", async () => {
    const res = await post("/v1/notifications/discord/setup", {
      webhookUrl: "https://discord.com/api/webhooks/x/y",
      enabled: true,
    });
    assert.equal(res.status, 400);
  });

  it("POST /v1/notifications/events/setup rejects invalid integration", async () => {
    const res = await post(`/v1/notifications/events/setup?clusterId=${fx.clusterId}`, {
      integration: "myspace",
      events: ["instance.created"],
    });
    assert.ok([400, 403].includes(res.status));
  });
});