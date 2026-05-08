// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";
import { FakeNode, createTestInstance, deleteTestInstance } from "./fixtures/fake-node.test.js";

/**
 * Node auth flow tests.
 * Covers: bootstrap token exchange, bad token rejection, WS connect auth.
 */
export function registerNodeAuthTests(getFx: () => TestFixtures) {
  describe("Node auth — token exchange", () => {
    let instanceId = "";
    let tag = "";
    let bootstrapToken = "";

    it("setup: create instance for node auth tests", async () => {
      const fx = getFx();
      const inst = await createTestInstance(fx.baseUrl, fx.session, fx.clusterId, `auth-${Date.now().toString(36)}`);
      instanceId = inst.instanceId;
      tag = inst.tag;
      bootstrapToken = inst.bootstrapToken;
      assert.ok(instanceId, "Instance must have an ID");
      assert.ok(bootstrapToken, "Must have a bootstrap token");
    });

    it("POST /v1/node/token with valid bootstrap token returns node access token", async () => {
      if (!bootstrapToken) return;
      const { baseUrl } = getFx();
      const res = await fetch(`${baseUrl}/v1/node/token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bootstrapToken}` },
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(body.data?.token, "Expected token in response");
      assert.ok(typeof body.data.token === "string" && body.data.token.length > 20, "Token should be a JWT");
    });

    it("POST /v1/node/token with missing Authorization returns 401", async () => {
      const { baseUrl } = getFx();
      const res = await fetch(`${baseUrl}/v1/node/token`, { method: "POST" });
      assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
    });

    it("POST /v1/node/token with garbage token returns 401", async () => {
      const { baseUrl } = getFx();
      const res = await fetch(`${baseUrl}/v1/node/token`, {
        method: "POST",
        headers: { Authorization: "Bearer not.a.real.jwt" },
      });
      assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
    });

    it("node WS connects successfully with valid node token", async () => {
      if (!bootstrapToken) return;
      const { baseUrl } = getFx();
      const node = new FakeNode({ baseUrl, instanceTag: tag, bootstrapToken });
      await node.exchangeToken();
      await node.connect();
      assert.ok(node.connected, "Node should be connected");
      node.disconnect();
    });

    it("node WS rejects connection with bad token", async () => {
      if (!tag) return;
      const { baseUrl } = getFx();
      const wsUrl = baseUrl.replace(/^http/, "ws") + `/v1/node/ws?instanceName=${tag}`;
      const { WebSocket } = await import("ws");

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: { Authorization: "Bearer garbage.token.here" } });
        ws.once("unexpected-response", (_req, res) => {
          assert.ok([401, 426].includes(res.statusCode ?? 0), `Expected 401 or 426, got ${res.statusCode}`);
          resolve();
        });
        ws.once("open", () => {
          ws.close();
          reject(new Error("Should not have connected with bad token"));
        });
        ws.once("error", () => resolve());
        setTimeout(() => resolve(), 3_000);
      });
    });

    it("node WS rejects connection with missing Authorization", async () => {
      if (!tag) return;
      const { baseUrl } = getFx();
      const wsUrl = baseUrl.replace(/^http/, "ws") + `/v1/node/ws?instanceName=${tag}`;
      const { WebSocket } = await import("ws");

      await new Promise<void>((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.once("unexpected-response", (_req, res) => {
          assert.ok([401, 426].includes(res.statusCode ?? 0));
          resolve();
        });
        ws.once("error", () => resolve());
        setTimeout(() => resolve(), 3_000);
      });
    });

    after(async () => {
      const { baseUrl, session } = getFx();
      if (instanceId) await deleteTestInstance(baseUrl, session, instanceId);
    });
  });
}
