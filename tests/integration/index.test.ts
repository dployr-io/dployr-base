// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupFixtures, type TestFixtures } from "./fixtures/index.test.js";
import { registerNodeAuthTests } from "./node-auth.test.js";
import { registerDeploymentLifecycleTests } from "./deployment-lifecycle.test.js";
import { registerServiceEnvTests, registerServiceSecretTests } from "./service-envs.test.js";
import "./hobby-ice-supervisor.test.js";
import { registerRateLimitTests } from "./rate-limit.test.js";
import { registerClusterIsolationTests } from "./cluster-isolation.test.js";

const TIMEOUT_FIXTURE_SETUP = 180_000;
const TIMEOUT_CLEANUP = 60_000;

let fx: TestFixtures;
let BASE_URL: string;

before(
  async () => {
    fx = await setupFixtures();
    BASE_URL = fx.baseUrl;
    console.log("[test] Fixtures ready");
  },
  { timeout: TIMEOUT_FIXTURE_SETUP },
);

after(
  async () => {
    await fx?.cleanup();
    console.log("[test] Cleanup done");
  },
  { timeout: TIMEOUT_CLEANUP },
);

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

function put(path: string, body: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: fx.session },
    body: JSON.stringify(body),
  });
}

async function assertOk(res: Response, status = 200) {
  const body = (await res.json()) as any;
  assert.equal(res.status, status, `Expected HTTP ${status}, got ${res.status}\nBody: ${JSON.stringify(body)}`);
  assert.equal(body.success, true, `Expected success:true\nBody: ${JSON.stringify(body)}`);
  return body;
}

function trackInstance(_id: string) {}
function randomOctet() {
  return Math.floor(Math.random() * 200) + 10;
}

describe("Health", () => {
  it("GET /v1/health returns ok", async () => {
    const res = await pub("/v1/health");
    assert.equal(res.status, 200, `Health check failed with ${res.status}`);
    const body = (await res.json()) as any;
    assert.equal(body.status, "ok", `Expected status:ok, got: ${JSON.stringify(body)}`);
    assert.ok(body.version, "Expected version field");
  });

  it("GET /v1/ws/stats returns stats or 503", async () => {
    const res = await pub("/v1/ws/stats");
    assert.ok([200, 503].includes(res.status), `Unexpected status ${res.status}`);
    if (res.status === 200) {
      const body = (await res.json()) as any;
      assert.equal(body.success, true);
      assert.ok(typeof body.data.totalConnections === "number", "Expected totalConnections to be a number");
    }
  });
});

describe("JWKS", () => {
  it("returns a keys array", async () => {
    const res = await pub("/v1/jwks/.well-known/jwks.json");
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.keys), "Expected keys to be an array");
    if (body.keys.length > 0) {
      assert.ok(body.keys[0].kty, "Expected kty field on key");
      assert.ok(body.keys[0].kid, "Expected kid field on key");
    }
  });
});

describe("Auth", () => {
  it("POST /v1/auth/login/email rejects missing email", async () => {
    const res = await pub("/v1/auth/login/email", { method: "POST", body: JSON.stringify({}) });
    assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
  });

  it("GET /v1/users/me rejects unauthenticated", async () => {
    const res = await pub("/v1/users/me");
    const body = (await res.json()) as any;
    assert.equal(res.status, 401, `Expected 401, got ${res.status}\nBody: ${JSON.stringify(body)}`);
    // Handle both {error:{code}} and flat {code} response shapes
    const code = body.error?.code ?? body.code;
    assert.equal(code, "auth.bad_session", `Expected auth.bad_session, got: ${JSON.stringify(body)}`);
  });

  it("OAuth login redirects for valid provider", async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/login/github`, { redirect: "manual" });
    assert.equal(res.status, 302, `Expected redirect 302, got ${res.status}`);
  });
});

describe("Users", () => {
  it("GET /v1/users/me returns user and clusters", async () => {
    const res = await get("/v1/users/me");
    const body = await assertOk(res);
    assert.ok(body.data.user.id, "Expected user.id");
    assert.ok(body.data.user.email, "Expected user.email");
    assert.ok(Array.isArray(body.data.clusters), "Expected clusters to be an array");
  });

  it("PATCH /v1/users/me rejects name too short", async () => {
    const res = await patch("/v1/users/me", { name: "ab" });
    assert.equal(res.status, 400, `Expected 400 for short name, got ${res.status}`);
  });

  it("PATCH /v1/users/me updates name", async () => {
    const res = await patch("/v1/users/me", { name: "CI Test User" });
    const body = await assertOk(res);
    assert.equal(body.data.user.name, "CI Test User", "Name was not updated");
  });

  it("PATCH /v1/users/me requires verification before changing email", async () => {
    const nextEmail = `ci-email-pending-${Date.now()}@example.com`;
    const before = await assertOk(await get("/v1/users/me"));

    const res = await patch("/v1/users/me", { email: nextEmail, name: "CI Test User" });
    const body = await assertOk(res);
    assert.equal(body.data.verificationRequired, true, "Expected email update to require verification");
    assert.equal(body.data.email, nextEmail);

    const after = await assertOk(await get("/v1/users/me"));
    assert.equal(after.data.user.email, before.data.user.email, "Email changed before OTP verification");
  });

  it("PATCH /v1/users/me changes email with verification code and refreshes session", async () => {
    const nextEmail = `ci-email-${Date.now()}@example.com`;
    const res = await patch("/v1/users/me", { email: nextEmail, code: "000000", name: "CI Email User" });
    const body = await assertOk(res);
    assert.equal(body.data.user.email, nextEmail, "Email was not updated");
    assert.equal(body.data.user.name, "CI Email User", "Profile fields should update with verified email change");

    const sessionRes = await get("/v1/users/me");
    const sessionBody = await assertOk(sessionRes);
    assert.equal(sessionBody.data.user.email, nextEmail, "Session did not reflect updated email");
  });

  it("PATCH /v1/users/me rejects duplicate email", async () => {
    const res = await patch("/v1/users/me", { email: "ci-test-other@example.com", code: "000000" });
    assert.equal(res.status, 409, `Expected 409 for duplicate email, got ${res.status}`);
  });

  it("PATCH /v1/users/me limits email changes to three per week", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await patch("/v1/users/me", { email: `ci-email-limit-${Date.now()}-${i}@example.com`, code: "000000" });
      await assertOk(res);
    }

    const blocked = await patch("/v1/users/me", { email: `ci-email-limit-blocked-${Date.now()}@example.com`, code: "000000" });
    assert.equal(blocked.status, 429, `Expected 429 after three weekly email changes, got ${blocked.status}`);
  });

});

describe("Clusters", () => {
  it("GET /v1/clusters contains the test cluster", async () => {
    const res = await get("/v1/clusters");
    const body = await assertOk(res);
    const ids = body.data.clusters.map((c: any) => c.id);
    assert.ok(ids.includes(fx.clusterId), `Test cluster ${fx.clusterId} not found in list: ${ids.join(", ")}`);
  });

  it("GET /v1/clusters/users/invites returns array", async () => {
    const res = await get("/v1/clusters/users/invites");
    const body = await assertOk(res);
    assert.ok(Array.isArray(body.data.invites), "Expected invites to be an array");
  });

  it("GET /v1/clusters/:id/users returns paginated members", async () => {
    const res = await get(`/v1/clusters/${fx.clusterId}/users`);
    const body = await assertOk(res);
    assert.ok(body.data.pagination, "Expected pagination object");
    assert.ok(Array.isArray(body.data.items), "Expected items to be an array");
  });

  it("POST /v1/clusters/:id/users rejects invalid emails", async () => {
    const res = await post(`/v1/clusters/${fx.clusterId}/users`, { users: ["not-an-email"] });
    assert.ok([400, 403].includes(res.status), `Expected 400 or 403, got ${res.status}`);
  });

  it("GET /v1/clusters/:id/integrations returns integration map", async () => {
    const res = await get(`/v1/clusters/${fx.clusterId}/integrations`);
    await assertOk(res);
  });

  it("GET /v1/clusters/:id/users rejects foreign cluster", async () => {
    const res = await get(`/v1/clusters/${fx.otherClusterId}/users`);
    assert.equal(res.status, 403, `Expected 403 for foreign cluster users, got ${res.status}`);
  });

  it("GET /v1/clusters/:id/integrations rejects foreign cluster", async () => {
    const res = await get(`/v1/clusters/${fx.otherClusterId}/integrations`);
    assert.equal(res.status, 403, `Expected 403 for foreign cluster integrations, got ${res.status}`);
  });

  it("GET /v1/clusters/:id/remotes rejects foreign cluster", async () => {
    const res = await get(`/v1/clusters/${fx.otherClusterId}/remotes`);
    assert.equal(res.status, 403, `Expected 403 for foreign cluster remotes, got ${res.status}`);
  });

  it("PATCH /v1/clusters/:id renames the cluster", async () => {
    const res = await patch(`/v1/clusters/${fx.clusterId}`, { name: "renamed-cluster" });
    const body = await assertOk(res);
    assert.equal(body.data.cluster.name, "renamed-cluster", "Expected cluster name to be updated");
  });

  it("GET /v1/clusters reflects new name after rename (session stays valid)", async () => {
    // Use otherClusterId so this rename doesn't collide with the cooldown from the
    // previous test which already renamed fx.clusterId.
    const renameRes = await fetch(`${BASE_URL}/v1/clusters/${fx.otherClusterId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: fx.otherSession },
      body: JSON.stringify({ name: "session-refresh-test" }),
    });
    await assertOk(renameRes);
    const res = await fetch(`${BASE_URL}/v1/clusters`, { headers: { Cookie: fx.otherSession } });
    const body = await assertOk(res, 200);
    const cluster = (body.data.clusters as any[]).find((c: any) => c.id === fx.otherClusterId);
    assert.ok(cluster, "Cluster should still be visible after rename");
    assert.equal(cluster.name, "session-refresh-test", "Cluster name should reflect the rename in the same session");
  });

  it("PATCH /v1/clusters/:id rejects empty name", async () => {
    const res = await patch(`/v1/clusters/${fx.clusterId}`, { name: "" });
    assert.equal(res.status, 400, `Expected 400 for empty name, got ${res.status}`);
  });

  it("PATCH /v1/clusters/:id rejects missing name", async () => {
    const res = await patch(`/v1/clusters/${fx.clusterId}`, {});
    assert.equal(res.status, 400, `Expected 400 for missing name, got ${res.status}`);
  });

  it("PATCH /v1/clusters/:id rejects unauthenticated", async () => {
    const res = await pub(`/v1/clusters/${fx.clusterId}`, { method: "PATCH", body: JSON.stringify({ name: "hacked" }) });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("PATCH /v1/clusters/:id rejects non-owner (other cluster session)", async () => {
    const res = await fetch(`${BASE_URL}/v1/clusters/${fx.otherClusterId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: fx.session },
      body: JSON.stringify({ name: "should-fail" }),
    });
    assert.equal(res.status, 403, `Expected 403 for non-owner rename, got ${res.status}`);
  });
});

describe("Instances", () => {
  let instanceId: string;

  it("GET /v1/instances returns paginated list", async () => {
    const res = await get(`/v1/instances?clusterId=${fx.clusterId}`);
    const body = await assertOk(res);
    assert.ok(body.data.pagination, "Expected pagination object");
  });

  it("GET /v1/instances rejects missing clusterId", async () => {
    const res = await get("/v1/instances");
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("GET /v1/instances rejects clusterId from a cluster user does not belong to", async () => {
    const res = await get(`/v1/instances?clusterId=${fx.otherClusterId}`);
    assert.equal(res.status, 403, `Expected 403 for foreign clusterId, got ${res.status}`);
  });

  it("POST /v1/instances rejects missing fields", async () => {
    const res = await post("/v1/instances", { address: "1.2.3.4" });
    assert.equal(res.status, 400, `Expected 400 for missing fields, got ${res.status}`);
  });

  it("POST /v1/instances rejects tag too short", async () => {
    const res = await post("/v1/instances", {
      clusterId: fx.clusterId,
      address: "10.0.0.1",
      tag: "ab",
    });
    assert.equal(res.status, 400, `Expected 400 for short tag, got ${res.status}`);
  });

  it("POST /v1/instances creates instance with bootstrap token", async () => {
    const tag = `ci-${Date.now().toString(36)}`;
    const res = await post("/v1/instances", {
      clusterId: fx.clusterId,
      address: `10.${randomOctet()}.${randomOctet()}.${randomOctet()}`,
      tag,
    });
    const body = (await res.json()) as any;

    if (res.status === 201) {
      assert.equal(body.success, true, `Expected success:true\nBody: ${JSON.stringify(body)}`);
      assert.ok(body.data.instance.id, "Expected instance.id in response");
      assert.ok(body.data.token, "Expected bootstrap token in response");
      instanceId = body.data.instance.id;
      trackInstance(instanceId);
    } else {
      assert.ok([400, 403, 409].includes(res.status), `Expected 200/400/403/409, got ${res.status}\nBody: ${JSON.stringify(body)}`);
    }
  });

  it("GET /v1/instances/:id returns instance", async () => {
    if (!instanceId) return;
    const res = await get(`/v1/instances/${instanceId}`);
    const body = await assertOk(res);
    assert.equal(body.data.id, instanceId, "Returned instance ID does not match");
  });

  it("GET /v1/instances/:id returns error for unknown id", async () => {
    const res = await get("/v1/instances/00000000000000000000000000");
    assert.ok([400, 404].includes(res.status), `Expected 400 or 404, got ${res.status}`);
  });

  it("DELETE /v1/instances/:id deletes instance", async () => {
    if (!instanceId) return;
    const res = await del(`/v1/instances/${instanceId}`);
    const body = await assertOk(res);
    assert.equal(body.data.deleted, true, "Expected deleted:true");
  });

  it("GET /v1/instances/:id after deletion returns error", async () => {
    if (!instanceId) return;
    const res = await get(`/v1/instances/${instanceId}`);
    assert.ok([400, 404].includes(res.status), `Expected 400 or 404 after deletion, got ${res.status}`);
  });
});

describe("Domains", () => {
  it("POST /v1/domains/register rejects invalid token", async () => {
    const res = await pub("/v1/domains/register", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    const body = (await res.json()) as any;
    assert.ok([400, 401].includes(res.status), `Expected 400 or 401, got ${res.status}\nBody: ${JSON.stringify(body)}`);
    const code = body.error?.code ?? body.code;
    assert.equal(code, "auth.bad_token", `Expected auth.bad_token, got: ${JSON.stringify(body)}`);
  });

  it("GET /v1/domains/verify returns 400 with no domain param", async () => {
    const res = await pub("/v1/domains/verify");
    assert.equal(res.status, 400, `Expected 400 for missing domain param, got ${res.status}`);
  });

  it("GET /v1/domains/verify returns error for unknown domain", async () => {
    const res = await pub("/v1/domains/verify?domain=not-real.example.com");
    assert.ok([403, 404].includes(res.status), `Expected 403 or 404, got ${res.status}`);
  });

  it("POST /v1/domains rejects unauthenticated", async () => {
    const res = await pub("/v1/domains", {
      method: "POST",
      body: JSON.stringify({ domain: "api.example.com", instanceId: "abc" }),
    });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });
});

describe("Billing", () => {
  it("GET /v1/billing/plans is public", async () => {
    const res = await pub("/v1/billing/plans");
    const body = await assertOk(res);
    assert.ok(Array.isArray(body.data.plans), "Expected plans to be an array");
  });

  it("GET /v1/billing/status rejects unauthenticated", async () => {
    const res = await pub("/v1/billing/status?clusterId=x");
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("GET /v1/billing/status rejects missing clusterId", async () => {
    const res = await get("/v1/billing/status");
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("GET /v1/billing/status returns subscription info", async () => {
    const res = await get(`/v1/billing/status?clusterId=${fx.clusterId}`);
    const body = (await res.json()) as any;
    assert.ok([200, 500].includes(res.status), `Expected 200 or 500, got ${res.status}`);
    if (res.status === 200) assert.ok(body.data.plan, "Expected plan field");
  });
});

describe("Runtime", () => {
  it("compatibility check — today's date is compatible", async () => {
    const today = new Date().toISOString().split("T")[0];
    const res = await pub("/v1/runtime/compatibility/check", {
      method: "POST",
      body: JSON.stringify({ compatibilityDate: today, version: "v0.4.8" }),
    });
    const body = await assertOk(res);
    assert.ok(typeof body.data.compatible === "boolean", "Expected compatible to be a boolean");
  });

  it("compatibility check — old date returns compatible:false", async () => {
    const res = await pub("/v1/runtime/compatibility/check", {
      method: "POST",
      body: JSON.stringify({ compatibilityDate: "2020-01-01", version: "v0.1.0" }),
    });
    const body = await assertOk(res);
    assert.equal(body.data.compatible, false, "Expected old date to be incompatible");
  });

  it("compatibility check — invalid date returns 400", async () => {
    const res = await pub("/v1/runtime/compatibility/check", {
      method: "POST",
      body: JSON.stringify({ compatibilityDate: "not-a-date" }),
    });
    assert.equal(res.status, 400, `Expected 400 for invalid date, got ${res.status}`);
  });

  it("GET /v1/runtime/events returns paginated events", async () => {
    const res = await get(`/v1/runtime/events?clusterId=${fx.clusterId}&pageSize=5`);
    const body = await assertOk(res);
    assert.ok(body.data.pagination, "Expected pagination object");
  });

  it("GET /v1/runtime/events rejects missing clusterId", async () => {
    const res = await get("/v1/runtime/events");
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });
});

describe("Proxy", () => {
  it("GET /v1/proxy/stats returns router info or 404", async () => {
    const res = await get("/v1/proxy/stats");
    assert.ok([200, 404, 503].includes(res.status), `Expected 200/404/503, got ${res.status}`);
    if (res.status === 200) {
      const body = (await res.json()) as any;
      assert.equal(body.success, true, `Expected success:true\nBody: ${JSON.stringify(body)}`);
    }
  });

  it("GET /v1/proxy/resolve rejects missing hostname or returns 404", async () => {
    const res = await get("/v1/proxy/resolve");
    assert.ok([400, 404].includes(res.status), `Expected 400 or 404, got ${res.status}`);
    if (res.status === 400) {
      const body = (await res.json()) as any;
      const code = body.error?.code ?? body.code;
      assert.ok(["validation.missing_fields", "request.bad_request"].includes(code), `Unexpected code: ${JSON.stringify(body)}`);
    }
  });

  it("GET /v1/proxy/resolve returns 404 for unknown service", async () => {
    const res = await get("/v1/proxy/resolve?hostname=nope.dployr.io");
    assert.ok([400, 404].includes(res.status), `Expected 400 or 404, got ${res.status}`);
  });

  it("GET /v1/proxy/services rejects missing clusterId", async () => {
    const res = await get("/v1/proxy/services");
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("GET /v1/proxy/services returns service list", async () => {
    const res = await get(`/v1/proxy/services?clusterId=${fx.clusterId}`);
    assert.ok([200, 404].includes(res.status), `Expected 200 or 404, got ${res.status}`);
    if (res.status === 200) {
      const body = (await res.json()) as any;
      assert.ok(Array.isArray(body.data.services), "Expected services to be an array");
    }
  });

  it("POST /v1/proxy/invalidate rejects empty body", async () => {
    const res = await post("/v1/proxy/invalidate", {});
    const body = (await res.json()) as any;
    assert.equal(res.status, 400, `Expected 400, got ${res.status}\nBody: ${JSON.stringify(body)}`);
    const code = body.error?.code ?? body.code;
    assert.equal(code, "request.bad_request", `Expected request.bad_request, got: ${JSON.stringify(body)}`);
  });
});

describe("Integrations", () => {
  it("GET /v1/integrations/list rejects missing clusterId", async () => {
    const res = await get("/v1/integrations/list");
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("GET /v1/integrations/list returns integrations", async () => {
    const res = await get(`/v1/integrations/list?clusterId=${fx.clusterId}`);
    await assertOk(res);
  });

  it("POST /v1/integrations/gitlab/setup rejects missing fields", async () => {
    const res = await post(`/v1/integrations/gitlab/setup?clusterId=${fx.clusterId}`, {});
    assert.ok([400, 401, 403].includes(res.status), `Expected 400, 401 or 403, got ${res.status}`);
  });
});

describe("Notifications", () => {
  it("POST /v1/notifications/discord/setup rejects missing clusterId", async () => {
    const res = await post("/v1/notifications/discord/setup", {
      webhookUrl: "https://discord.com/api/webhooks/x/y",
      enabled: true,
    });
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("POST /v1/notifications/events/setup rejects invalid integration", async () => {
    const res = await post(`/v1/notifications/events/setup?clusterId=${fx.clusterId}`, {
      integration: "myspace",
      events: ["instance.created"],
    });
    assert.ok([400, 403].includes(res.status), `Expected 400 or 403 for invalid integration, got ${res.status}`);
  });
});

describe("Services", () => {
  const unknownId = "00000000000000000000000000";

  it("GET /v1/services rejects unauthenticated", async () => {
    const res = await pub(`/v1/services?clusterId=${fx.clusterId}`);
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("GET /v1/services rejects missing clusterId", async () => {
    const res = await get("/v1/services");
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("GET /v1/services rejects foreign clusterId", async () => {
    const res = await get(`/v1/services?clusterId=${fx.otherClusterId}`);
    assert.equal(res.status, 403, `Expected 403 for foreign clusterId, got ${res.status}`);
  });

  it("GET /v1/services returns list for valid clusterId", async () => {
    const res = await get(`/v1/services?clusterId=${fx.clusterId}`);
    const body = await assertOk(res);
    const list = body.data.services ?? body.data.items;
    assert.ok(Array.isArray(list), "Expected services/items to be an array");
  });

  it("GET /v1/services/:id returns 404 for unknown id", async () => {
    const res = await get(`/v1/services/${unknownId}`);
    assert.ok([400, 404].includes(res.status), `Expected 400 or 404 for unknown service, got ${res.status}`);
  });

  it("PATCH /v1/services/:id rejects unauthenticated", async () => {
    const res = await pub(`/v1/services/${unknownId}`, { method: "PATCH", body: JSON.stringify({}) });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("DELETE /v1/services/:id rejects unauthenticated", async () => {
    const res = await pub(`/v1/services/${unknownId}`, { method: "DELETE" });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("GET /v1/services/:id/envs returns 404 for unknown id", async () => {
    const res = await get(`/v1/services/${unknownId}/envs`);
    assert.ok([400, 404].includes(res.status), `Expected 400 or 404 for unknown service envs, got ${res.status}`);
  });

  it("PUT /v1/services/:id/envs rejects unauthenticated", async () => {
    const res = await pub(`/v1/services/${unknownId}/envs`, { method: "PUT", body: JSON.stringify({}) });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("DELETE /v1/services/:id/envs/:key rejects unauthenticated", async () => {
    const res = await pub(`/v1/services/${unknownId}/envs/SOME_KEY`, { method: "DELETE" });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });
});

describe("Deployments", () => {
  const unknownId = "00000000000000000000000000";

  it("GET /v1/deployments rejects unauthenticated", async () => {
    const res = await pub(`/v1/deployments?clusterId=${fx.clusterId}`);
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("GET /v1/deployments rejects missing clusterId", async () => {
    const res = await get("/v1/deployments");
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("GET /v1/deployments rejects foreign clusterId", async () => {
    const res = await get(`/v1/deployments?clusterId=${fx.otherClusterId}`);
    assert.equal(res.status, 403, `Expected 403 for foreign clusterId, got ${res.status}`);
  });

  it("GET /v1/deployments returns list for valid clusterId", async () => {
    const res = await get(`/v1/deployments?clusterId=${fx.clusterId}`);
    const body = await assertOk(res);
    const list = body.data.deployments ?? body.data.items;
    assert.ok(Array.isArray(list), "Expected deployments/items to be an array");
  });

  it("GET /v1/deployments/:id returns 404 for unknown id", async () => {
    const res = await get(`/v1/deployments/${unknownId}`);
    assert.ok([400, 403, 404].includes(res.status), `Expected 400/403/404 for unknown deployment, got ${res.status}`);
  });

  it("POST /v1/deployments rejects missing body fields", async () => {
    const res = await post(`/v1/deployments?clusterId=${fx.clusterId}`, {});
    assert.equal(res.status, 400, `Expected 400 for missing body fields, got ${res.status}`);
  });

  it("POST /v1/deployments rejects invalid body (non-string serviceId)", async () => {
    const res = await post(`/v1/deployments?clusterId=${fx.clusterId}`, { serviceId: 123 });
    assert.equal(res.status, 400, `Expected 400 for invalid body, got ${res.status}`);
  });

  it("POST /v1/deployments rejects missing clusterId", async () => {
    const res = await post("/v1/deployments", { serviceId: "some-service" });
    assert.equal(res.status, 400, `Expected 400 for missing clusterId, got ${res.status}`);
  });

  it("POST /v1/deployments rejects unauthenticated", async () => {
    const res = await pub(`/v1/deployments?clusterId=${fx.clusterId}`, {
      method: "POST",
      body: JSON.stringify({ serviceId: "some-service" }),
    });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });

  it("POST /v1/deployments with valid body returns 503 or 400 when no node connected", async () => {
    const res = await post(`/v1/deployments?clusterId=${fx.clusterId}`, {
      serviceId: unknownId,
    });
    const body = (await res.json()) as any;
    // No node is connected in CI; expect either a validation 400 (unknown serviceId)
    // or a 503 with runtime.node_not_connected
    assert.ok([400, 503].includes(res.status), `Expected 400 or 503, got ${res.status}\nBody: ${JSON.stringify(body)}`);
    if (res.status === 503) {
      const code = body.error?.code ?? body.code;
      assert.equal(code, "runtime.node_not_connected", `Expected runtime.node_not_connected, got: ${JSON.stringify(body)}`);
    }
  });

  it("DELETE /v1/deployments/:id returns 404 for unknown id", async () => {
    const res = await del(`/v1/deployments/${unknownId}`);
    assert.ok([400, 403, 404].includes(res.status), `Expected 400/403/404 for unknown deployment, got ${res.status}`);
  });

  it("DELETE /v1/deployments/:id rejects unauthenticated", async () => {
    const res = await pub(`/v1/deployments/${unknownId}`, { method: "DELETE" });
    assert.ok([401, 403].includes(res.status), `Expected 401 or 403, got ${res.status}`);
  });
});

// ── Layer 2: Node auth, deployment lifecycle, rate limiting, cluster isolation ──
// These run after all Layer 1 tests since they share the same fixture setup.
// Each suite registers itself via a function to keep index.ts as the single entry point.
// Pass a lazy getter so each it() callback reads the live fx set by before().
const getFx = () => fx;
registerNodeAuthTests(getFx);
registerDeploymentLifecycleTests(getFx);

registerClusterIsolationTests(getFx);
registerRateLimitTests(getFx);
registerServiceEnvTests(getFx);
registerServiceSecretTests(getFx);
