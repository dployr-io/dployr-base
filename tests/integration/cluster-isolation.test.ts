// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.js";
import { createTestInstance, deleteTestInstance } from "./fixtures/fake-node.js";

/**
 * Cluster isolation tests.
 * Verifies a user cannot read or mutate resources belonging to another cluster.
 */
export function registerClusterIsolationTests(getFx: () => TestFixtures) {
  describe("Cluster isolation", () => {
    let ownInstanceId = "";

    it("setup: create instance in own cluster", async () => {
      const { baseUrl, session, clusterId } = getFx();
      const inst = await createTestInstance(baseUrl, session, clusterId, `iso-${Date.now().toString(36)}`);
      ownInstanceId = inst.instanceId;
      assert.ok(ownInstanceId);
    });

    it("GET /v1/deployments with foreign clusterId returns 403", async () => {
      const { baseUrl, session, otherClusterId } = getFx();
      const res = await fetch(`${baseUrl}/v1/deployments?clusterId=${otherClusterId}`, {
        headers: { Cookie: session },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    it("POST /v1/deployments with foreign clusterId returns 403", async () => {
      const { baseUrl, session, otherClusterId } = getFx();
      const res = await fetch(`${baseUrl}/v1/deployments?clusterId=${otherClusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({ instanceName: "any", payload: {} }),
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    it("GET /v1/services with foreign clusterId returns 403", async () => {
      const { baseUrl, session, otherClusterId } = getFx();
      const res = await fetch(`${baseUrl}/v1/services?clusterId=${otherClusterId}`, {
        headers: { Cookie: session },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    it("GET /v1/instances with foreign clusterId returns 403", async () => {
      const { baseUrl, session, otherClusterId } = getFx();
      const res = await fetch(`${baseUrl}/v1/instances?clusterId=${otherClusterId}`, {
        headers: { Cookie: session },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    it("GET /v1/clusters/:id/users with foreign cluster returns 403", async () => {
      const { baseUrl, session, otherClusterId } = getFx();
      const res = await fetch(`${baseUrl}/v1/clusters/${otherClusterId}/users`, {
        headers: { Cookie: session },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    it("GET /v1/clusters/:id/integrations with foreign cluster returns 403", async () => {
      const { baseUrl, session, otherClusterId } = getFx();
      const res = await fetch(`${baseUrl}/v1/clusters/${otherClusterId}/integrations`, {
        headers: { Cookie: session },
      });
      assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
    });

    it("GET /v1/users/me without session returns 401", async () => {
      const { baseUrl } = getFx();
      const res = await fetch(`${baseUrl}/v1/users/me`);
      assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
    });

    it("GET /v1/deployments without session returns 401 or 403", async () => {
      const { baseUrl, clusterId } = getFx();
      const res = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`);
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("DELETE /v1/instances/:id of own instance succeeds", async () => {
      if (!ownInstanceId) return;
      const { baseUrl, session } = getFx();
      const res = await fetch(`${baseUrl}/v1/instances/${ownInstanceId}`, {
        method: "DELETE",
        headers: { Cookie: session },
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200 for own instance delete, got ${res.status}: ${JSON.stringify(body)}`);
      ownInstanceId = "";
    });

    after(async () => {
      const { baseUrl, session } = getFx();
      if (ownInstanceId) await deleteTestInstance(baseUrl, session, ownInstanceId);
    });
  });
}
