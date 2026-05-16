// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";
import { FakeNode, createTestInstance, deleteTestInstance } from "./fixtures/fake-node.test.js";

export function registerServiceSecretTests(getFx: () => TestFixtures) {
  describe("Service secrets", () => {
    let instanceId = "";
    let tag = "";
    let bootstrapToken = "";
    let node: FakeNode | null = null;
    let serviceId = "";
    const svcName = `ci-secret-svc-${Date.now().toString(36)}`;

    it("setup: create instance and connect fake node", async () => {
      const { baseUrl, session, clusterId } = getFx();
      const inst = await createTestInstance(baseUrl, session, clusterId, `sec-${Date.now().toString(36)}`);
      instanceId = inst.instanceId;
      tag = inst.tag;
      bootstrapToken = inst.bootstrapToken;

      node = new FakeNode({ baseUrl, instanceTag: tag, bootstrapToken });
      await node.exchangeToken();
      await node.connect();
      assert.ok(node.connected, "Fake node must be connected before secrets tests");
    });

    it("dispatch deployment with secrets and finish — secret keys appear via GET /services/:id/secrets", async () => {
      if (!node?.connected) return;
      const { baseUrl, session, clusterId } = getFx();

      const taskPromise = node.waitForTask(8_000);

      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({
          instanceName: tag,
          payload: {
            name: svcName,
            user_id: "ci-user",
            type: "web",
            source: "image",
            image: "node:20-alpine",
            port: 3000,
            secrets: { DB_PASSWORD: "supersecret", API_KEY: "abc123" },
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

      const finishBody = (await finishRes.json()) as any;
      assert.equal(finishRes.status, 200, `/finish failed: ${JSON.stringify(finishBody)}`);

      // Look up the service by listing and matching by name
      const listRes = await fetch(`${baseUrl}/v1/services?clusterId=${clusterId}`, {
        headers: { Cookie: session },
      });
      const listBody = (await listRes.json()) as any;
      assert.equal(listRes.status, 200, `Services list failed: ${JSON.stringify(listBody)}`);

      const items: any[] = listBody.data?.items ?? listBody.data?.services ?? [];
      const svc = items.find((s: any) => s.name === svcName);
      assert.ok(svc, `Service '${svcName}' not found in list`);
      serviceId = svc.id;

      const secretsRes = await fetch(`${baseUrl}/v1/services/${serviceId}/secrets`, {
        headers: { Cookie: session },
      });
      const secretsBody = (await secretsRes.json()) as any;

      if (secretsRes.status === 503) return; // secrets not configured on this server — skip

      assert.equal(secretsRes.status, 200, `GET secrets failed: ${JSON.stringify(secretsBody)}`);

      const keys: string[] = (secretsBody.data?.secrets ?? []).map((s: any) => s.key);
      assert.ok(keys.includes("DB_PASSWORD"), "DB_PASSWORD should be listed");
      assert.ok(keys.includes("API_KEY"), "API_KEY should be listed");
    });

    it("GET /services/:id/secrets returns metadata only — no plaintext values", async () => {
      if (!serviceId) return;
      const { baseUrl, session } = getFx();

      const res = await fetch(`${baseUrl}/v1/services/${serviceId}/secrets`, {
        headers: { Cookie: session },
      });
      if (res.status === 503) return;

      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `GET secrets failed: ${JSON.stringify(body)}`);

      for (const secret of body.data?.secrets ?? []) {
        assert.ok(!("value" in secret), `Secret '${secret.key}' must not expose plaintext value`);
        assert.ok("key" in secret, "Secret entry must have a key field");
        assert.ok("createdAt" in secret, "Secret entry must have a createdAt field");
      }
    });

    it("PUT /services/:id/secrets sets secrets and GET returns updated key list", async () => {
      if (!serviceId) return;
      const { baseUrl, session } = getFx();

      const putRes = await fetch(`${baseUrl}/v1/services/${serviceId}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({ secrets: { SMTP_PASS: "mailpass", STRIPE_KEY: "sk_test_abc" } }),
      });
      if (putRes.status === 503) return;
      assert.equal(putRes.status, 200, `PUT secrets failed: ${await putRes.text()}`);

      const secretsRes = await fetch(`${baseUrl}/v1/services/${serviceId}/secrets`, {
        headers: { Cookie: session },
      });
      if (secretsRes.status === 503) return;
      const body = (await secretsRes.json()) as any;
      const keys: string[] = (body.data?.secrets ?? []).map((s: any) => s.key);
      assert.ok(keys.includes("SMTP_PASS"), "SMTP_PASS should be present");
      assert.ok(keys.includes("STRIPE_KEY"), "STRIPE_KEY should be present");
    });

    it("DELETE /services/:id/secrets/:key removes a single secret", async () => {
      if (!serviceId) return;
      const { baseUrl, session } = getFx();

      const delRes = await fetch(`${baseUrl}/v1/services/${serviceId}/secrets/STRIPE_KEY`, {
        method: "DELETE",
        headers: { Cookie: session },
      });
      if (delRes.status === 503) return;
      assert.equal(delRes.status, 200, `DELETE secret key failed: ${await delRes.text()}`);

      const secretsRes = await fetch(`${baseUrl}/v1/services/${serviceId}/secrets`, {
        headers: { Cookie: session },
      });
      if (secretsRes.status === 503) return;
      const body = (await secretsRes.json()) as any;
      const keys: string[] = (body.data?.secrets ?? []).map((s: any) => s.key);
      assert.ok(!keys.includes("STRIPE_KEY"), "STRIPE_KEY should be removed");
      assert.ok(keys.includes("SMTP_PASS"), "SMTP_PASS should still be present");
    });

    after(async () => {
      node?.disconnect();
      const { baseUrl, session } = getFx();
      if (instanceId) await deleteTestInstance(baseUrl, session, instanceId);
    });
  });
}

export function registerServiceEnvTests(getFx: () => TestFixtures) {
  describe("Service environment variables", () => {
    let instanceId = "";
    let tag = "";
    let bootstrapToken = "";
    let node: FakeNode | null = null;
    let serviceId = "";
    const svcName = `ci-env-svc-${Date.now().toString(36)}`;

    it("setup: create instance and connect fake node", async () => {
      const { baseUrl, session, clusterId } = getFx();
      const inst = await createTestInstance(baseUrl, session, clusterId, `env-${Date.now().toString(36)}`);
      instanceId = inst.instanceId;
      tag = inst.tag;
      bootstrapToken = inst.bootstrapToken;

      node = new FakeNode({ baseUrl, instanceTag: tag, bootstrapToken });
      await node.exchangeToken();
      await node.connect();
      assert.ok(node.connected, "Fake node must be connected before env tests");
    });

    it("dispatch deployment with env_vars and finish — envs appear via GET /services/:id/envs", async () => {
      if (!node?.connected) return;
      const { baseUrl, session, clusterId } = getFx();

      const taskPromise = node.waitForTask(8_000);

      const dispatchRes = await fetch(`${baseUrl}/v1/deployments?clusterId=${clusterId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({
          instanceName: tag,
          payload: {
            name: svcName,
            user_id: "ci-user",
            type: "web",
            source: "image",
            image: "node:20-alpine",
            port: 3000,
            env_vars: { NODE_ENV: "production", PORT: "3000" },
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

      const finishBody = (await finishRes.json()) as any;
      assert.equal(finishRes.status, 200, `/finish failed: ${JSON.stringify(finishBody)}`);

      // Look up the service by listing and matching by name
      const listRes = await fetch(`${baseUrl}/v1/services?clusterId=${clusterId}`, {
        headers: { Cookie: session },
      });
      const listBody = (await listRes.json()) as any;
      assert.equal(listRes.status, 200, `Services list failed: ${JSON.stringify(listBody)}`);

      const items: any[] = listBody.data?.items ?? listBody.data?.services ?? [];
      const svc = items.find((s: any) => s.name === svcName);
      assert.ok(svc, `Service '${svcName}' not found in list`);
      serviceId = svc.id;

      const envsRes = await fetch(`${baseUrl}/v1/services/${serviceId}/envs`, {
        headers: { Cookie: session },
      });
      const envsBody = (await envsRes.json()) as any;
      assert.equal(envsRes.status, 200, `GET envs failed: ${JSON.stringify(envsBody)}`);

      const envs: Record<string, string> = envsBody.data?.envs ?? {};
      assert.equal(envs["NODE_ENV"], "production", "NODE_ENV should be 'production'");
      assert.equal(envs["PORT"], "3000", "PORT should be '3000'");
    });

    it("PUT /services/:id/envs overwrites all envs and GET returns the new set", async () => {
      if (!serviceId) return;
      const { baseUrl, session } = getFx();

      const putRes = await fetch(`${baseUrl}/v1/services/${serviceId}/envs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: session },
        body: JSON.stringify({ envs: { APP_NAME: "dployr", LOG_LEVEL: "info" } }),
      });
      assert.equal(putRes.status, 200, `PUT envs failed: ${await putRes.text()}`);

      const envsRes = await fetch(`${baseUrl}/v1/services/${serviceId}/envs`, {
        headers: { Cookie: session },
      });
      const envsBody = (await envsRes.json()) as any;
      const envs: Record<string, string> = envsBody.data?.envs ?? {};
      assert.equal(envs["APP_NAME"], "dployr");
      assert.equal(envs["LOG_LEVEL"], "info");
    });

    it("DELETE /services/:id/envs/:key removes a single key", async () => {
      if (!serviceId) return;
      const { baseUrl, session } = getFx();

      const delRes = await fetch(`${baseUrl}/v1/services/${serviceId}/envs/LOG_LEVEL`, {
        method: "DELETE",
        headers: { Cookie: session },
      });
      assert.equal(delRes.status, 200, `DELETE env key failed: ${await delRes.text()}`);

      const envsRes = await fetch(`${baseUrl}/v1/services/${serviceId}/envs`, {
        headers: { Cookie: session },
      });
      const envsBody = (await envsRes.json()) as any;
      const envs: Record<string, string> = envsBody.data?.envs ?? {};
      assert.ok(!("LOG_LEVEL" in envs), "LOG_LEVEL should be removed");
      assert.equal(envs["APP_NAME"], "dployr", "APP_NAME should still be present");
    });

    after(async () => {
      node?.disconnect();
      const { baseUrl, session } = getFx();
      if (instanceId) await deleteTestInstance(baseUrl, session, instanceId);
    });
  });
}
