// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";
import { FakeNode, createTestInstance } from "./fixtures/fake-node.test.js";

export function registerServiceLogsTests(getFx: () => TestFixtures) {
  describe("GET /v1/services/:id/logs — deployment fallback", () => {
    let node: FakeNode | null = null;
    const ts = Date.now().toString(36);
    const svcName = `ci-logs-${ts}`;
    let deploymentId = "";

    it("setup: connect fake node and create a pending deployment (no service yet)", async () => {
      const { baseUrl, session, clusterId } = getFx();

      const inst = await createTestInstance(baseUrl, session, clusterId, `logs-${ts}`);
      node = new FakeNode({ baseUrl, instanceTag: inst.tag, bootstrapToken: inst.bootstrapToken });
      await node.exchangeToken();
      await node.connect();
      assert.ok(node.connected, "Fake node must be connected");

      const res = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({ name: svcName, type: "web", source: "image", image: "node:20-alpine", port: 3000 }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 202, `Deployment dispatch failed: ${JSON.stringify(body)}`);
      deploymentId = body.data?.taskId;
      assert.ok(deploymentId, "Expected taskId");
    });

    it("returns non-404 for a deployment name when no service record exists yet", async () => {
      const { baseUrl, session } = getFx();

      // Service record does not exist — deployment is still pending.
      // Endpoint must fall back to deployment lookup and return 501 (Loki disabled
      // in test env), NOT 404 (resource not found).
      const res = await fetch(`${baseUrl}/v1/services/${svcName}/logs`, {
        headers: { Cookie: session },
      });
      const body = (await res.json()) as any;

      assert.notEqual(res.status, 404, `Must not return 404 when deployment exists but service does not: ${JSON.stringify(body)}`);
      assert.equal(res.status, 501, `Expected 501 LOGS_NOT_AVAILABLE (Loki disabled in test), got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.error.code, "LOGS_NOT_AVAILABLE");
    });

    it("returns 404 when neither service nor deployment exists", async () => {
      const { baseUrl, session } = getFx();

      const res = await fetch(`${baseUrl}/v1/services/completely-unknown-service/logs`, {
        headers: { Cookie: session },
      });
      const body = (await res.json()) as any;

      assert.equal(res.status, 404, `Expected 404 for unknown name: ${JSON.stringify(body)}`);
    });

    it("teardown", async () => {
      await node?.disconnect?.();
    });
  });
}
