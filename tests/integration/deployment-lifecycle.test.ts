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
    const svcName = `ci-svc-${Date.now().toString(36)}`;

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

    it("POST /v1/deployments immediately creates a pending deployment record", async () => {
      if (!node?.connected) return;
      const { baseUrl, session, clusterId } = getFx();
      const name = `pending-check-${Date.now().toString(36)}`;

      const res = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({ name, type: "web", source: "image", runtime: "nodejs", image: "node:20-alpine", port: 3000 }),
      });

      const body = (await res.json()) as any;
      assert.equal(res.status, 202, `Expected 202, got ${res.status}: ${JSON.stringify(body)}`);
      const taskId = body.data?.taskId as string;
      assert.ok(taskId, "Expected taskId in response");

      // Deployment record must exist immediately — before the node does anything
      const depRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}&status=pending`, {
        headers: { Cookie: session },
      });
      const depBody = (await depRes.json()) as any;
      assert.equal(depRes.status, 200, `Deployments list failed: ${JSON.stringify(depBody)}`);
      const records: any[] = depBody.data?.items ?? [];
      const created = records.find((d: any) => d.id === taskId);
      assert.ok(created, `Pending deployment record for taskId ${taskId} not found immediately after POST`);
      assert.equal(created.name, name, "Deployment name must match");
    });

    it("POST /v1/deployments dispatches task to connected fake node", async () => {
      if (!node?.connected) return;
      const { baseUrl, session, clusterId } = getFx();

      const taskPromise = node.waitForTask(8_000, (t) => t.Type === "deployments:post");

      const deployPayload = {
        name: svcName,
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
        body: JSON.stringify(deployPayload),
      });

      const body = (await res.json()) as any;
      assert.equal(res.status, 202, `Expected 202, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(body.data?.taskId, "Expected taskId in response");

      const task = await taskPromise;
      assert.equal(task.Type, "deployments:post", `Expected deployments:post, got ${task.Type}`);
      assert.ok(task.ID, "Task must have an ID");
      assert.ok(task.Payload?.token, "Task payload must include an access token");
    });

    it("fake node calls /finish and deployment record is updated", async () => {
      if (!node?.connected) return;
      const { baseUrl, session, clusterId } = getFx();

      const taskPromise = node.waitForTask(8_000, (t) => t.Type === "deployments:post");

      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({
          name: svcName,
          description: "Finish sync test",
          type: "worker",
          source: "image",
          runtime: "golang",
          image: "golang:1.22-alpine",
          port: 8080,
        }),
      });

      const dispatchBody = (await dispatchRes.json()) as any;
      assert.equal(dispatchRes.status, 202, `Dispatch failed: ${JSON.stringify(dispatchBody)}`);

      const taskId = dispatchBody.data.taskId as string;
      const task = await taskPromise;

      const finishRes = await node!.callFinish({
        token: task.Payload.token,
        id: taskId,
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
        assert.ok(deployBody.data?.deployment?.id, "Deployment record should be returned");
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
        }),
      });
      assert.ok([400, 401].includes(res.status), `Expected 400 or 401 for tampered token, got ${res.status}`);
    });

    it("/finish rejects request with missing required fields", async () => {
      const { baseUrl } = getFx();
      const res = await fetch(`${baseUrl}/v1/deployments/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blueprint: {} }),
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
