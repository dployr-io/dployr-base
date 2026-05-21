// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";
import { FakeNode, createTestInstance, createTestBuildNode, deleteTestInstance } from "./fixtures/fake-node.test.js";

export function registerServicePatchTests(getFx: () => TestFixtures) {
  describe("PATCH /v1/services/:id", () => {
    let instanceId = "";
    let tag = "";
    let bootstrapToken = "";
    let node: FakeNode | null = null;
    let buildNode: FakeNode | null = null;
    let buildNodeInstanceId = "";
    let serviceId = "";
    let deploymentId = "";
    const ts = Date.now().toString(36);
    const svcName = `ci-patch-${ts}`;

    it("setup: deploy a service via fake node so PATCH has something to update", async () => {
      const { baseUrl, otherSession, otherClusterId } = getFx();

      const inst = await createTestInstance(baseUrl, otherSession, otherClusterId, `patch-${ts}`);
      instanceId = inst.instanceId;
      tag = inst.tag;
      bootstrapToken = inst.bootstrapToken;

      node = new FakeNode({ baseUrl, instanceTag: tag, bootstrapToken });
      await node.exchangeToken();
      await node.connect();
      assert.ok(node.connected, "Fake node must be connected");

      const bn = await createTestBuildNode(baseUrl, otherSession, otherClusterId, ts);
      buildNode = bn.node;
      buildNodeInstanceId = bn.instanceId;
      assert.ok(buildNode.connected, "Build node must be connected");

      const taskPromise = node.waitForTask(8_000);

      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${otherClusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: otherSession },
        body: JSON.stringify({
          instanceName: tag,
          payload: {
            name: svcName,
            user_id: "ci-user",
            type: "web",
            source: "image",
            image: "node:20-alpine",
            port: 3000,
          },
        }),
      });
      const dispatchBody = (await dispatchRes.json()) as any;
      assert.equal(dispatchRes.status, 202, `Dispatch failed: ${JSON.stringify(dispatchBody)}`);
      deploymentId = dispatchBody.data.taskId;

      const task = await taskPromise;
      const finishRes = await node!.callFinish({
        token: task.Payload.token,
        id: deploymentId,
        logs: "[ci] started",
        blueprint: {
          name: svcName,
          user_id: "ci-user",
          type: "web",
          source: "image",
          image: "node:20-alpine",
          port: 3000,
        },
      });
      assert.equal(finishRes.status, 200, `/finish failed: ${await finishRes.text()}`);

      const listRes = await fetch(`${baseUrl}/v1/services?clusterId=${otherClusterId}`, {
        headers: { Cookie: otherSession },
      });
      const listBody = (await listRes.json()) as any;
      const items: any[] = listBody.data?.items ?? listBody.data?.services ?? [];
      const svc = items.find((s: any) => s.name === svcName);
      assert.ok(svc, `Service '${svcName}' not found after deploy`);
      serviceId = svc.id;
    });

    it("PATCH rejects missing instanceName", async () => {
      if (!serviceId) return;
      const { baseUrl, otherSession } = getFx();

      const res = await fetch(`${baseUrl}/v1/services/${serviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: otherSession },
        body: JSON.stringify({ port: 4000 }),
      });
      assert.equal(res.status, 400, `Expected 400 for missing instanceName, got ${res.status}`);
    });

    it("PATCH rejects invalid port (negative)", async () => {
      if (!serviceId) return;
      const { baseUrl, otherSession } = getFx();

      const res = await fetch(`${baseUrl}/v1/services/${serviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: otherSession },
        body: JSON.stringify({ instanceName: tag, port: -1 }),
      });
      assert.equal(res.status, 400, `Expected 400 for negative port, got ${res.status}`);
    });

    it("PATCH updates port and run_cmd — deployment record reflects new values and node receives task", async () => {
      if (!node?.connected || !serviceId) return;
      const { baseUrl, otherSession } = getFx();

      const taskPromise = node.waitForTask(8_000);

      const res = await fetch(`${baseUrl}/v1/services/${serviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: otherSession },
        body: JSON.stringify({ instanceName: tag, port: 4000, run_cmd: "node server.js" }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(body)}`);

      // DB: deployment record has updated values
      assert.equal(body.data.deployment.port, 4000, "port should be updated in deployment");
      assert.equal(body.data.deployment.runCmd, "node server.js", "runCmd should be updated");
      assert.equal(body.data.deployment.status, "pending", "status should reset to pending");

      // Node: task payload carries the new values
      const task = await taskPromise;
      assert.equal(task.Payload?.port, 4000, "task payload should have new port");
      assert.equal(task.Payload?.run_cmd, "node server.js", "task payload should have new run_cmd");
    });

    it("PATCH with image field updates image and keeps source='image'", async () => {
      if (!node?.connected || !serviceId) return;
      const { baseUrl, otherSession } = getFx();

      const taskPromise = node.waitForTask(8_000);

      const res = await fetch(`${baseUrl}/v1/services/${serviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: otherSession },
        body: JSON.stringify({ instanceName: tag, image: "node:22-alpine" }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(body)}`);

      assert.equal(body.data.deployment.image, "node:22-alpine", "image should be updated");
      assert.equal(body.data.deployment.source, "image", "source should remain 'image'");

      const task = await taskPromise;
      assert.equal(task.Payload?.source, "image", "task source should be 'image'");
      assert.equal(task.Payload?.image, "node:22-alpine", "task should carry new image");
    });

    it("PATCH with remote_url switches source to 'remote' and build node receives remote config", async () => {
      if (!buildNode?.connected || !serviceId) return;
      const { baseUrl, otherSession } = getFx();

      const taskPromise = buildNode.waitForTask(8_000);

      const res = await fetch(`${baseUrl}/v1/services/${serviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: otherSession },
        body: JSON.stringify({
          instanceName: tag,
          remote_url: "https://github.com/example/app",
          remote_branch: "main",
          image: null,
        }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(body)}`);

      assert.equal(body.data.deployment.source, "remote", "source should switch to 'remote'");
      assert.equal(body.data.deployment.remoteUrl, "https://github.com/example/app");
      assert.equal(body.data.deployment.remoteBranch, "main");
      assert.equal(body.data.deployment.image, null, "image should be cleared");

      const task = await taskPromise;
      assert.equal(task.Type, "builds:post", "task type should be builds:post");
      assert.equal(task.Payload?.source, "remote", "task source should be 'remote'");
      assert.ok(task.Payload?.remote?.url, "task should have remote.url");
      assert.equal(task.Payload?.remote?.branch, "main");
      assert.equal(task.Payload?.image, undefined, "task should not carry image");
    });

    it("PATCH with null fields clears values — deployment and build task reflect the cleared state", async () => {
      if (!buildNode?.connected || !serviceId) return;
      const { baseUrl, otherSession } = getFx();

      const taskPromise = buildNode.waitForTask(8_000);

      const res = await fetch(`${baseUrl}/v1/services/${serviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: otherSession },
        body: JSON.stringify({
          instanceName: tag,
          run_cmd: null,
          remote_url: "https://github.com/example/app",
          remote_branch: "main",
        }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(body)}`);
      assert.equal(body.data.deployment.runCmd, null, "runCmd should be cleared");

      const task = await taskPromise;
      assert.equal(task.Type, "builds:post", "task type should be builds:post");
      assert.equal(task.Payload?.run_cmd, undefined, "cleared run_cmd should not appear in task");
    });

    after(async () => {
      node?.disconnect();
      buildNode?.disconnect();
      const { baseUrl, otherSession } = getFx();
      if (instanceId) await deleteTestInstance(baseUrl, otherSession, instanceId);
      if (buildNodeInstanceId) await deleteTestInstance(baseUrl, otherSession, buildNodeInstanceId);
    });
  });
}
