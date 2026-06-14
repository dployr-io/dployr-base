// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "@/lib/storage/kv.interface.js";
import { EventStore } from "@/lib/db/store/kv/event.js";
import { resolveTargets } from "@/services/background/jobs/notify.js";


describe("EventStore.logSystemEvent", () => {
  it("writes an actor-scoped entry", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({ type: "service.deleted", clusterId: "cluster-1" });

    const keys = (await kv.list({ prefix: "actor:system:" })).map((k) => k.name);
    assert.equal(keys.length, 1);
  });

  it("writes a cluster-scoped entry indexed by clusterId", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({ type: "deployment.created", clusterId: "cluster-abc" });

    const keys = (await kv.list({ prefix: "target:cluster-abc:" })).map((k) => k.name);
    assert.equal(keys.length, 1);
  });

  it("stored event contains the correct type", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({ type: "domain.verified", clusterId: "c1" });

    const [key] = await kv.list({ prefix: "target:c1:" });
    const event = JSON.parse((await kv.get(key.name))!);
    assert.equal(event.type, "domain.verified");
  });

  it("stored event contains display targets", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({
      type: "service.stopped",
      clusterId: "c1",
      targets: [{ id: "my-app", name: "my-app" }],
    });

    const [key] = await kv.list({ prefix: "target:c1:" });
    const event = JSON.parse((await kv.get(key.name))!);
    assert.deepEqual(event.targets, [{ id: "my-app", name: "my-app" }]);
  });

  it("stored event has empty targets array when none provided", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({ type: "cluster.modified", clusterId: "c1" });

    const [key] = await kv.list({ prefix: "target:c1:" });
    const event = JSON.parse((await kv.get(key.name))!);
    assert.deepEqual(event.targets, []);
  });

  it("does not index under clusterId as a target entity", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({
      type: "service.deleted",
      clusterId: "cluster-xyz",
      targets: [{ id: "my-service", name: "my-service" }],
    });

    // The target entry should be keyed by clusterId, not by service name
    const byCluster = await kv.list({ prefix: "target:cluster-xyz:" });
    assert.equal(byCluster.length, 1);

    // No entry keyed by the service name
    const byService = await kv.list({ prefix: "target:my-service:" });
    assert.equal(byService.length, 0);
  });

  it("getClusterEvents returns the logged event", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({
      type: "deployment.finished",
      clusterId: "c2",
      targets: [{ id: "api", name: "api" }],
    });

    const events = await store.getClusterEvents("c2");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "deployment.finished");
    assert.deepEqual(events[0].targets, [{ id: "api", name: "api" }]);
  });

  it("getClusterEvents does not return events from a different cluster", async () => {
    const kv = new MemoryKV();
    const store = new EventStore(kv);

    await store.logSystemEvent({ type: "service.started", clusterId: "c1" });
    await store.logSystemEvent({ type: "service.stopped", clusterId: "c2" });

    const events = await store.getClusterEvents("c1");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "service.started");
  });
});

// ── resolveTargets ───────────────────────────────────────────────────────────

describe("resolveTargets", () => {
  const base = { clusterId: "c1" };

  it("returns serviceName when present", () => {
    const targets = resolveTargets({ ...base, serviceName: "my-app" });
    assert.deepEqual(targets, [{ id: "my-app", name: "my-app" }]);
  });

  it("returns domain when present", () => {
    const targets = resolveTargets({ ...base, domain: "api.example.com" });
    assert.deepEqual(targets, [{ id: "api.example.com", name: "api.example.com" }]);
  });

  it("returns tokenName when present", () => {
    const targets = resolveTargets({ ...base, tokenName: "ci-token" });
    assert.deepEqual(targets, [{ id: "ci-token", name: "ci-token" }]);
  });

  it("returns deploymentId when present", () => {
    const targets = resolveTargets({ ...base, deploymentId: "01ABC" });
    assert.deepEqual(targets, [{ id: "01ABC", name: "01ABC" }]);
  });

  it("returns instanceId when present", () => {
    const targets = resolveTargets({ ...base, instanceId: "node-us-east-1" });
    assert.deepEqual(targets, [{ id: "node-us-east-1", name: "node-us-east-1" }]);
  });

  it("returns userEmail when present", () => {
    const targets = resolveTargets({ ...base, userEmail: "user@example.com" });
    assert.deepEqual(targets, [{ id: "user@example.com", name: "user@example.com" }]);
  });

  it("returns clusterName as fallback with clusterId", () => {
    const targets = resolveTargets({ ...base, clusterName: "My Cluster" });
    assert.deepEqual(targets, [{ id: "c1", name: "My Cluster" }]);
  });

  it("returns empty array when no meaningful field is present", () => {
    const targets = resolveTargets({ clusterId: "c1" });
    assert.deepEqual(targets, []);
  });

  it("serviceName takes precedence over domain", () => {
    const targets = resolveTargets({ ...base, serviceName: "api", domain: "api.example.com" });
    assert.deepEqual(targets, [{ id: "api", name: "api" }]);
  });

  it("domain takes precedence over tokenName", () => {
    const targets = resolveTargets({ ...base, domain: "x.com", tokenName: "tok" });
    assert.deepEqual(targets, [{ id: "x.com", name: "x.com" }]);
  });
});
