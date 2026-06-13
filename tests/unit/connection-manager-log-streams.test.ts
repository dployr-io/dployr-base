// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ConnectionManager } from "@/services/websocket/connection-manager.js";

function makeStream(overrides: Record<string, any> = {}) {
  return {
    nodeStreamId: "stream-1",
    key: "build:task-1",
    path: "my-svc",
    meta: { serviceId: "my-svc", source: "build" as const, clusterId: "cluster-1" },
    clients: new Set<any>(),
    duration: "24h",
    ...overrides,
  };
}

describe("ConnectionManager — log stream lifecycle", () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager({ cleanupIntervalMs: 999_999 });
  });

  afterEach(() => {
    cm.stopCleanupLoop();
  });

  it("addLogStream registers in path map and nodeStreamIndex", () => {
    const added = cm.addLogStream(makeStream());
    assert.equal(added, true);
    assert.ok(cm.getLogStreamByPath("build:task-1"), "must find by stream key");
    assert.ok(cm.getLogStreamByNodeId("stream-1"), "must find by nodeStreamId");
  });

  it("addLogStream returns false for duplicate key without touching nodeStreamIndex", () => {
    cm.addLogStream(makeStream());
    const second = cm.addLogStream(makeStream({ nodeStreamId: "stream-2" }));
    assert.equal(second, false, "second add with same key must be rejected");
    assert.ok(cm.getLogStreamByNodeId("stream-1"), "original nodeStreamId must still be indexed");
    assert.equal(cm.getLogStreamByNodeId("stream-2"), undefined, "rejected nodeStreamId must not be indexed");
  });

  it("getLogStreamByNodeId returns undefined for unknown id", () => {
    assert.equal(cm.getLogStreamByNodeId("unknown"), undefined);
  });

  it("getLogStreamByPath returns undefined for unknown key", () => {
    assert.equal(cm.getLogStreamByPath("service:ghost"), undefined);
  });

  it("addClientToLogStream adds WebSocket to the fanout set", () => {
    cm.addLogStream(makeStream());
    const fakeWs = {} as any;
    const ok = cm.addClientToLogStream("build:task-1", fakeWs);
    assert.equal(ok, true);
    assert.ok(cm.getLogStreamByPath("build:task-1")!.clients.has(fakeWs));
  });

  it("addClientToLogStream returns false when stream not found", () => {
    const ok = cm.addClientToLogStream("nonexistent", {} as any);
    assert.equal(ok, false);
  });

  it("removeClientFromLogStream removes the ws without destroying the stream", () => {
    cm.addLogStream(makeStream());
    const fakeWs = {} as any;
    cm.addClientToLogStream("build:task-1", fakeWs);
    cm.removeClientFromLogStream("build:task-1", fakeWs);
    const stream = cm.getLogStreamByPath("build:task-1");
    assert.ok(stream, "stream must still exist after client removed");
    assert.equal(stream!.clients.has(fakeWs), false, "client must be removed from fanout set");
  });

  it("removeLogStream cleans both path map and nodeStreamIndex", () => {
    cm.addLogStream(makeStream());
    cm.removeLogStream("build:task-1");
    assert.equal(cm.getLogStreamByPath("build:task-1"), undefined, "must be gone from path map");
    assert.equal(cm.getLogStreamByNodeId("stream-1"), undefined, "must be gone from nodeStreamIndex");
  });

  it("three independent streams coexist — build, deploy, service", () => {
    cm.addLogStream(makeStream({ nodeStreamId: "s1", key: "build:t1",   meta: { serviceId: "svc", source: "build" } }));
    cm.addLogStream(makeStream({ nodeStreamId: "s2", key: "deploy:t1",  meta: { serviceId: "svc", source: "deploy" } }));
    cm.addLogStream(makeStream({ nodeStreamId: "s3", key: "service:svc", meta: { serviceId: "svc", source: "runtime" } }));

    assert.equal(cm.getLogStreamByPath("build:t1")!.meta.source, "build");
    assert.equal(cm.getLogStreamByPath("deploy:t1")!.meta.source, "deploy");
    assert.equal(cm.getLogStreamByPath("service:svc")!.meta.source, "runtime");
    assert.ok(cm.getLogStreamByNodeId("s1"));
    assert.ok(cm.getLogStreamByNodeId("s2"));
    assert.ok(cm.getLogStreamByNodeId("s3"));
  });

  it("removeLogStreamsForClient removes ws from all streams", () => {
    const ws = {} as any;
    cm.addLogStream(makeStream({ nodeStreamId: "s1", key: "build:t1" }));
    cm.addLogStream(makeStream({ nodeStreamId: "s2", key: "service:svc" }));
    cm.addClientToLogStream("build:t1", ws);
    cm.addClientToLogStream("service:svc", ws);

    cm.removeLogStreamsForClient(ws);

    assert.equal(cm.getLogStreamByPath("build:t1")!.clients.has(ws), false);
    assert.equal(cm.getLogStreamByPath("service:svc")!.clients.has(ws), false);
  });
});
