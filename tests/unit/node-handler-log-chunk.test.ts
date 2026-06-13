// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeMessageHandler } from "@/services/websocket/handlers/node-handler.js";

function makeStream(key: string, path: string, source: string) {
  return {
    nodeStreamId: `ns-${key}`,
    key,
    path,
    meta: { serviceId: path, source, clusterId: "cluster-1" },
    clients: new Set<any>(),
    duration: "24h" as const,
  };
}

function logChunkMsg(streamId: string, entries: any[] = [{ time: "2026-01-01T00:00:00Z", level: "INFO", msg: "hello" }]) {
  return { kind: "log_chunk", streamId, entries } as any;
}

function makeLoki() {
  const pushed: Array<{ path: string; meta: any; entries: any[] }> = [];
  return {
    isEnabled: true,
    push(path: string, meta: any, entries: any[]) { pushed.push({ path, meta, entries }); },
    _pushed: pushed,
  } as any;
}

function makeConnectionManager(streams: Record<string, any>) {
  return {
    updateActivity: () => {},
    getLogStreamByNodeId: (id: string) => Object.values(streams).find((s: any) => s.nodeStreamId === id),
    getConnections: () => [],
    getPendingRequest: () => null,
    routeResponseToClient: () => {},
    getFileWatchSubscribers: () => null,
    sendTask: () => false,
    addLogStream: () => false,
    removeLogStream: () => {},
  } as any;
}

function makeHandler(cm: any, loki: any) {
  return new NodeMessageHandler(
    cm,
    { broadcast: async () => {}, notifyRefresh: () => {} } as any,
    { deployments: { get: async () => null, updateBuildResult: async () => {} }, instances: { find: async () => null } } as any,
    { payloads: { consumeBuildCallback: async () => null, listBuildQueue: async () => [] }, instanceCache: { decrementBuildSlots: async () => 0, untrackInFlightBuild: async () => {} } } as any,
    { createNodeAccessToken: async () => "tok" } as any,
    loki,
  );
}

describe("NodeMessageHandler.handleLogChunk — Loki push routing", () => {
  it("pushes to Loki for build:<taskId> stream", async () => {
    const loki = makeLoki();
    const stream = makeStream("build:task-1", "my-svc", "build");
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, loki);

    const conn = { clusterId: "cluster-1", instanceTag: "build-node-1", ws: { readyState: 1 } } as any;
    await handler.handleMessage({ conn, message: logChunkMsg("ns-build:task-1") });

    assert.equal(loki._pushed.length, 1, "Loki must receive one push for build stream");
    assert.equal(loki._pushed[0].path, "build:task-1");
  });

  it("pushes to Loki for deploy:<taskId> stream", async () => {
    const loki = makeLoki();
    const stream = makeStream("deploy:task-2", "my-svc", "deploy");
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, loki);

    const conn = { clusterId: "cluster-1", instanceTag: "instance-a", ws: { readyState: 1 } } as any;
    await handler.handleMessage({ conn, message: logChunkMsg("ns-deploy:task-2") });

    assert.equal(loki._pushed.length, 1, "Loki must receive one push for deploy stream");
    assert.equal(loki._pushed[0].path, "deploy:task-2");
  });

  it("does NOT push to Loki for service:<name> stream — Vector handles runtime logs", async () => {
    const loki = makeLoki();
    const stream = makeStream("service:my-svc", "my-svc", "runtime");
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, loki);

    const conn = { clusterId: "cluster-1", instanceTag: "instance-a", ws: { readyState: 1 } } as any;
    await handler.handleMessage({ conn, message: logChunkMsg("ns-service:my-svc") });

    assert.equal(loki._pushed.length, 0, "Loki must NOT receive a push for runtime stream");
  });

  it("does NOT push to Loki for logs:<name> stream — legacy runtime key", async () => {
    const loki = makeLoki();
    const stream = makeStream("logs:my-svc", "my-svc", "runtime");
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, loki);

    const conn = { clusterId: "cluster-1", instanceTag: "instance-a", ws: { readyState: 1 } } as any;
    await handler.handleMessage({ conn, message: logChunkMsg("ns-logs:my-svc") });

    assert.equal(loki._pushed.length, 0, "Loki must NOT receive a push for legacy runtime stream");
  });

  it("fans out source=build to subscribed clients for build: stream", async () => {
    const received: any[] = [];
    const stream = makeStream("build:task-3", "my-svc", "build");
    stream.clients.add({ send: (raw: string) => received.push(JSON.parse(raw)) });
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, makeLoki());

    const conn = { clusterId: "cluster-1", instanceTag: "build-node-1", ws: { readyState: 1 } } as any;
    await handler.handleMessage({ conn, message: logChunkMsg("ns-build:task-3") });

    assert.equal(received.length, 1);
    assert.equal(received[0].source, "build", "fan-out must inject source=build");
  });

  it("fans out source=deploy to subscribed clients for deploy: stream", async () => {
    const received: any[] = [];
    const stream = makeStream("deploy:task-4", "my-svc", "deploy");
    stream.clients.add({ send: (raw: string) => received.push(JSON.parse(raw)) });
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, makeLoki());

    const conn = { clusterId: "cluster-1", instanceTag: "instance-a", ws: { readyState: 1 } } as any;
    await handler.handleMessage({ conn, message: logChunkMsg("ns-deploy:task-4") });

    assert.equal(received.length, 1);
    assert.equal(received[0].source, "deploy", "fan-out must inject source=deploy");
  });

  it("fans out source=runtime to subscribed clients for service: stream", async () => {
    const received: any[] = [];
    const stream = makeStream("service:my-svc", "my-svc", "runtime");
    stream.clients.add({ send: (raw: string) => received.push(JSON.parse(raw)) });
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, makeLoki());

    const conn = { clusterId: "cluster-1", instanceTag: "instance-a", ws: { readyState: 1 } } as any;
    await handler.handleMessage({ conn, message: logChunkMsg("ns-service:my-svc") });

    assert.equal(received.length, 1);
    assert.equal(received[0].source, "runtime", "fan-out must inject source=runtime");
  });

  it("does not push to Loki when loki is disabled", async () => {
    const loki = { isEnabled: false, push: () => { throw new Error("should not be called"); } } as any;
    const stream = makeStream("build:task-5", "my-svc", "build");
    const cm = makeConnectionManager({ [stream.key]: stream });
    const handler = makeHandler(cm, loki);

    const conn = { clusterId: "cluster-1", instanceTag: "build-node-1", ws: { readyState: 1 } } as any;
    await assert.doesNotReject(() =>
      handler.handleMessage({ conn, message: logChunkMsg("ns-build:task-5") })
    );
  });

  it("drops chunk silently when no stream is registered for the nodeStreamId", async () => {
    const loki = makeLoki();
    const cm = makeConnectionManager({});
    const handler = makeHandler(cm, loki);

    const conn = { clusterId: "cluster-1", instanceTag: "build-node-1", ws: { readyState: 1 } } as any;
    await assert.doesNotReject(() =>
      handler.handleMessage({ conn, message: logChunkMsg("ns-unknown") })
    );
    assert.equal(loki._pushed.length, 0);
  });
});
