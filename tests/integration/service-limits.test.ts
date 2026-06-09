// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";
import { FakeNode, createTestInstance, deleteTestInstance } from "./fixtures/fake-node.test.js";
import { SERVICE_LIMIT_BY_TIER } from "@/lib/constants/instances.js";

export function registerServiceLimitTests(getFx: () => TestFixtures) {
  describe("Service tier limits", () => {
    let instanceId = "";
    let tag = "";
    let bootstrapToken = "";
    let node: FakeNode | null = null;
    const ts = Date.now().toString(36);
    const svc1 = `ci-lim1-${ts}`;
    const svc2 = `ci-lim2-${ts}`;

    it("setup: create instance and connect fake node on limit cluster (hobby)", async () => {
      const { baseUrl, limitSession, limitClusterId } = getFx();
      const inst = await createTestInstance(baseUrl, limitSession, limitClusterId, `lim-${ts}`);
      instanceId = inst.instanceId;
      tag = inst.tag;
      bootstrapToken = inst.bootstrapToken;

      node = new FakeNode({ baseUrl, instanceTag: tag, bootstrapToken });
      await node.exchangeToken();
      await node.connect();
      assert.ok(node.connected, "Fake node must be connected before limit tests");
    });

    it(`hobby plan (limit=${SERVICE_LIMIT_BY_TIER.hobby}): first service deploys successfully`, async () => {
      if (!node?.connected) return;
      const { baseUrl, limitSession, limitClusterId } = getFx();

      const taskPromise = node.waitForTask(8_000, (t) => t.Type === "deployments:post");
      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${limitClusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: limitSession },
        body: JSON.stringify({
          name: svc1, type: "web", source: "image", image: "node:20-alpine", port: 3000,
        }),
      });
      const dispatchBody = (await dispatchRes.json()) as any;
      assert.equal(dispatchRes.status, 202, `Expected 202, got ${JSON.stringify(dispatchBody)}`);

      const task = await taskPromise;
      const finishRes = await node!.callFinish({
        token: task.Payload.token,
        id: dispatchBody.data.taskId,

        blueprint: { name: svc1, user_id: "ci-user", type: "web", source: "image", image: "node:20-alpine", port: 3000 },
      });
      assert.equal(finishRes.status, 200, `/finish failed: ${await finishRes.text()}`);
    });

    it(`hobby plan (limit=${SERVICE_LIMIT_BY_TIER.hobby}): second service is blocked`, async () => {
      if (!node?.connected) return;
      const { baseUrl, limitSession, limitClusterId } = getFx();

      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${limitClusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: limitSession },
        body: JSON.stringify({
          name: svc2, type: "web", source: "image", image: "node:20-alpine", port: 3000,
        }),
      });
      const dispatchBody = (await dispatchRes.json()) as any;
      assert.equal(dispatchRes.status, 400, `Expected 400 (service limit), got ${dispatchRes.status}: ${JSON.stringify(dispatchBody)}`);
      const code = dispatchBody.error?.code ?? dispatchBody.code;
      assert.equal(code, "request.bad_request", `Expected request.bad_request, got ${code}`);
    });

    it(`upgrading to indie (limit=${SERVICE_LIMIT_BY_TIER.indie}): second service now dispatches`, async () => {
      if (!node?.connected) return;
      const { baseUrl, limitSession, limitClusterId, setClusterPlan } = getFx();

      await setClusterPlan(limitClusterId, "indie");

      const taskPromise = node.waitForTask(8_000, (t) => t.Type === "deployments:post");
      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${limitClusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: limitSession },
        body: JSON.stringify({
          name: svc2, type: "web", source: "image", image: "node:20-alpine", port: 3000,
        }),
      });
      const dispatchBody = (await dispatchRes.json()) as any;
      assert.equal(dispatchRes.status, 202, `Expected 202 after indie upgrade, got ${JSON.stringify(dispatchBody)}`);

      const task = await taskPromise;
      await node!.callFinish({
        token: task.Payload.token,
        id: dispatchBody.data.taskId,

        blueprint: { name: svc2, user_id: "ci-user", type: "web", source: "image", image: "node:20-alpine", port: 3000 },
      });
    });

    it(`indie plan (limit=${SERVICE_LIMIT_BY_TIER.indie}): deployment blocked at limit`, async () => {
      const { baseUrl, limitSession, limitClusterId, insertFakeServices } = getFx();

      // svc1 + svc2 already exist (2 real services). Fill remaining slots to hit indie limit.
      await insertFakeServices(limitClusterId, SERVICE_LIMIT_BY_TIER.indie - 2);

      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${limitClusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: limitSession },
        body: JSON.stringify({
          name: `ci-lim3-${ts}`, type: "web", source: "image", image: "node:20-alpine", port: 3000,
        }),
      });
      const dispatchBody = (await dispatchRes.json()) as any;
      assert.equal(dispatchRes.status, 400, `Expected 400 (indie limit), got ${dispatchRes.status}: ${JSON.stringify(dispatchBody)}`);
      const code = dispatchBody.error?.code ?? dispatchBody.code;
      assert.equal(code, "request.bad_request", `Expected request.bad_request at indie limit, got ${code}`);
    });

    it(`upgrading to pro (limit=${SERVICE_LIMIT_BY_TIER.pro}): deployment unblocked`, async () => {
      const { baseUrl, limitSession, limitClusterId, setClusterPlan } = getFx();

      await setClusterPlan(limitClusterId, "pro");

      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${limitClusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: limitSession },
        body: JSON.stringify({
          name: `ci-lim3-${ts}`, type: "web", source: "image", image: "node:20-alpine", port: 3000,
        }),
      });
      const dispatchBody = (await dispatchRes.json()) as any;
      // Limit check passes. Node may still be connected (202) or have disconnected (503).
      // Either way, a 400 service-limit error here would be a bug.
      assert.ok(
        [202, 503].includes(dispatchRes.status),
        `Expected 202 or 503 after pro upgrade, got ${dispatchRes.status}: ${JSON.stringify(dispatchBody)}`
      );
      if (dispatchRes.status === 503) {
        const code = dispatchBody.error?.code ?? dispatchBody.code;
        assert.equal(code, "runtime.node_not_connected", `Expected runtime.node_not_connected, got ${code}`);
      }
    });

    after(async () => {
      node?.disconnect();
      const { baseUrl, limitSession } = getFx();
      if (instanceId) await deleteTestInstance(baseUrl, limitSession, instanceId);
    });
  });
}
