// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";
import { FakeNode, createTestInstance, deleteTestInstance } from "./fixtures/fake-node.test.js";

export function registerDeploymentLifecycleTests(getFx: () => TestFixtures) {
  describe("Deployment lifecycle", () => {
    let instanceId = "";
    let tag = "";
    let bootstrapToken = "";
    let node: FakeNode | null = null;

    it("setup: create instance and connect fake node", async () => {
      const { baseUrl, session, clusterId } = getFx();
      const inst = await createTestInstance(baseUrl, session, clusterId, `deploy-${Date.now().toString(36)}`);
      instanceId = inst.instanceId;
      tag = inst.tag;
      bootstrapToken = inst.bootstrapToken;

      node = new FakeNode({ baseUrl, instanceTag: tag, bootstrapToken });
      await node.exchangeToken();
      await node.connect();
      assert.ok(node.connected, "Fake node must be connected before deployment tests");
    });

    it("POST /v1/deployments dispatches task to connected fake node", async () => {
      if (!node?.connected) return;
      const { baseUrl, session, clusterId } = getFx();

      const taskPromise = node.waitForTask(8_000);

      const deployPayload = {
        name: `ci-svc-${Date.now().toString(36)}`,
        description: "CI test service",
        user_id: "ci-user",
        type: "web",
        source: "image",
        runtime: "nodejs",
        image: "node:20-alpine",
        port: 3000,
      };

      const res = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({ instanceName: tag, payload: deployPayload }),
      });

      const body = (await res.json()) as any;
      assert.equal(res.status, 202, `Expected 202, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(body.data?.taskId, "Expected taskId in response");

      const task = await taskPromise;
      assert.equal(task.Type, "deployments:post", `Expected deployments:post, got ${task.Type}`);
      assert.ok(task.ID, "Task must have an ID");
      assert.ok(task.Payload?.token, "Task payload must include an access token");
    });

    it("fake node calls /finish and deployment record is updated with logs", async () => {
      if (!node?.connected) return;
      const { baseUrl, session, clusterId } = getFx();

      const taskPromise = node.waitForTask(8_000);

      const svcName = `ci-finish-${Date.now().toString(36)}`;
      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({
          instanceName: tag,
          payload: {
            name: svcName,
            description: "Finish sync test",
            user_id: "ci-user",
            type: "worker",
            source: "image",
            runtime: "golang",
            image: "golang:1.22-alpine",
            port: 8080,
          },
        }),
      });

      const dispatchBody = (await dispatchRes.json()) as any;
      assert.equal(dispatchRes.status, 202, `Dispatch failed: ${JSON.stringify(dispatchBody)}`);

      const taskId = dispatchBody.data.taskId as string;
      const task = await taskPromise;

      const finishRes = await node!.callFinish({
        token: task.Payload.token,
        id: taskId,
        logs: "[ci] build started\n[ci] build completed\n[ci] service started on :8080",
        blueprint: {
          name: svcName,
          description: "Finish sync test",
          user_id: "ci-user",
          type: "worker",
          source: "image",
          image: "golang:1.22-alpine",
          port: 8080,
        },
      });

      const finishBody = (await finishRes.json()) as any;
      assert.equal(finishRes.status, 200, `/finish failed: ${JSON.stringify(finishBody)}`);
      assert.equal(finishBody.success, true, "Expected success:true from /finish");

      // Verify logs are persisted
      const deployRes = await fetch(`${baseUrl}/v1/deployments/${taskId}`, {
        headers: { Cookie: session },
      });

      if (deployRes.status === 200) {
        const deployBody = (await deployRes.json()) as any;
        assert.ok(deployBody.data?.deployment?.logs?.includes("[ci] build completed"), "Logs should be persisted on deployment record");
      }
    });

    it("/finish rejects a tampered/invalid token", async () => {
      const { baseUrl } = getFx();
      const res = await fetch(`${baseUrl}/v1/deployments/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJoYWNrZWQifQ.invalidsig",
          id: "01JZZZZZZZZZZZZZZZZZZZZZZ0",
          logs: "hacked",
        }),
      });
      assert.ok([400, 401].includes(res.status), `Expected 400 or 401 for tampered token, got ${res.status}`);
    });

    it("/finish rejects request with missing required fields", async () => {
      const { baseUrl } = getFx();
      const res = await fetch(`${baseUrl}/v1/deployments/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logs: "missing token and id" }),
      });
      assert.equal(res.status, 400, `Expected 400 for missing fields, got ${res.status}`);
    });

    after(async () => {
      node?.disconnect();
      const { baseUrl, session } = getFx();
      if (instanceId) await deleteTestInstance(baseUrl, session, instanceId);
    });
  });
}
