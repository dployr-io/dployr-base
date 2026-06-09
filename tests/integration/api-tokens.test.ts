// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";

/**
 * Integration tests for /v1/auth/oidc/bindings (OIDC binding CRUD).
 *
 * Token exchange itself requires a live CI OIDC token and cannot be exercised
 * in unit/integration tests without mocking the upstream JWKS endpoint.
 * These tests cover the management API that authenticated users interact with.
 */
export function registerApiTokenTests(getFx: () => TestFixtures) {
  describe("OIDC bindings — CRUD", () => {
    let bindingId = "";

    function auth(init: RequestInit = {}): RequestInit {
      return { ...init, headers: { "Content-Type": "application/json", Cookie: getFx().session, ...((init.headers as object) ?? {}) } };
    }

    it("GET /v1/auth/oidc/bindings returns empty array for fresh user", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(Array.isArray(body.data?.items), "Expected data to be an array");
    });

    it("GET /v1/auth/oidc/bindings rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`);
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("POST /v1/auth/oidc/bindings creates a binding", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({
          clusterId: getFx().clusterId,
          provider: "github",
          issuer: "https://token.actions.githubusercontent.com",
          subject: "repo:acme/app:environment:production",
          name: "GitHub Actions — production",
        }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(body.data.id, "Expected binding id");
      assert.equal(body.data.provider, "github");
      assert.equal(body.data.issuer, "https://token.actions.githubusercontent.com");
      assert.equal(body.data.subject, "repo:acme/app:environment:production");
      assert.equal(body.data.name, "GitHub Actions — production");
      bindingId = body.data.id;
    });

    it("POST /v1/auth/oidc/bindings rejects missing issuer", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({
          clusterId: getFx().clusterId,
          provider: "github",
          subject: "repo:acme/app:environment:production",
        }),
      });
      assert.equal(res.status, 400, `Expected 400 for missing issuer, got ${res.status}`);
    });

    it("POST /v1/auth/oidc/bindings rejects http:// issuer", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({
          clusterId: getFx().clusterId,
          provider: "github",
          issuer: "http://token.actions.githubusercontent.com",
          subject: "repo:acme/app:environment:production",
        }),
      });
      assert.equal(res.status, 400, `Expected 400 for http issuer, got ${res.status}`);
    });

    it("POST /v1/auth/oidc/bindings rejects invalid provider", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({
          clusterId: getFx().clusterId,
          provider: "jenkins",
          issuer: "https://jenkins.example.com",
          subject: "pipeline/main",
        }),
      });
      assert.equal(res.status, 400, `Expected 400 for invalid provider, got ${res.status}`);
    });

    it("POST /v1/auth/oidc/bindings rejects duplicate issuer+subject", async () => {
      if (!bindingId) return;
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({
          clusterId: getFx().clusterId,
          provider: "github",
          issuer: "https://token.actions.githubusercontent.com",
          subject: "repo:acme/app:environment:production",
        }),
      });
      assert.equal(res.status, 409, `Expected 409 for duplicate, got ${res.status}`);
    });

    it("POST /v1/auth/oidc/bindings rejects cluster the user cannot write to", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, {
        headers: { "Content-Type": "application/json", Cookie: getFx().otherSession },
        method: "POST",
        body: JSON.stringify({
          clusterId: getFx().clusterId,
          provider: "gitlab",
          issuer: "https://gitlab.com",
          subject: "project_path:acme/app:ref_type:branch:ref:main",
        }),
      });
      assert.ok([401, 403].includes(res.status), `Expected 401/403 for wrong user, got ${res.status}`);
    });

    it("GET /v1/auth/oidc/bindings lists created binding", async () => {
      if (!bindingId) return;
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      const found = body.data?.items?.find((b: any) => b.id === bindingId);
      assert.ok(found, "Created binding must appear in list");
    });

    it("DELETE /v1/auth/oidc/bindings/:id removes the binding", async () => {
      if (!bindingId) return;
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings/${bindingId}`, auth({ method: "DELETE" }));
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    });

    it("GET /v1/auth/oidc/bindings no longer lists deleted binding", async () => {
      if (!bindingId) return;
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      const found = body.data?.items?.find((b: any) => b.id === bindingId);
      assert.ok(!found, "Deleted binding must not appear in list");
    });

    it("DELETE /v1/auth/oidc/bindings/:id returns 404 for unknown id", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings/00000000-0000-0000-0000-000000000000`, auth({ method: "DELETE" }));
      assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    });

    it("DELETE /v1/auth/oidc/bindings/:id rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/bindings/some-id`, { method: "DELETE" });
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("POST /v1/auth/oidc/exchange rejects missing token", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400, `Expected 400 for missing token, got ${res.status}`);
    });

    it("POST /v1/auth/oidc/exchange rejects unrecognised token", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/oidc/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "not.a.jwt" }),
      });
      assert.ok([400, 401].includes(res.status), `Expected 400/401 for garbage token, got ${res.status}`);
    });
  });
}
