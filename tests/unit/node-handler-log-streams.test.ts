// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeMessageHandler } from "@/services/websocket/handlers/node-handler.js";
import type { BuildCallback } from "@/lib/db/store/kv/payload.js";

const CALLBACK: BuildCallback = {
  callbackInstanceTag: "instance-a",
  buildNodeTag: "build-node-1",
  clusterId: "cluster-1",
  fingerprint: "fp-abc",
  payload: { name: "my-svc", user_id: "u1", type: "web", source: "remote", runtime: "nodejs", force_rebuild: false } as any,
};

function taskResponseMsg(taskId: string, data?: any) {
  return { kind: "task_response", taskId, success: true, data } as any;
}

function makeConnectionManager(opts: { sentTasks?: any[]; addedStreams?: any[]; addReturns?: boolean } = {}) {
  const sent = opts.sentTasks ?? [];
  const streams = opts.addedStreams ?? [];
  const shouldAdd = opts.addReturns ?? true;
  return {
    updateActivity: () => {},
    getPendingRequest: () => null,
    routeResponseToClient: () => {},
    getConnections: () => [],
    getFileWatchSubscribers: () => null,
    sendTask: (tag: string, task: any) => { sent.push({ tag, task }); return true; },
    addLogStream: (stream: any) => { streams.push(stream); return shouldAdd; },
    removeLogStream: () => {},
  } as any;
}

function makeConnectionManagerConditional(sentTasks: any[], addedStreams: any[]) {
  return {
    updateActivity: () => {},
    getPendingRequest: () => null,
    routeResponseToClient: () => {},
    getConnections: () => [],
    getFileWatchSubscribers: () => null,
    sendTask: (tag: string, task: any) => { sentTasks.push({ tag, task }); return true; },
    // Returns false for the service stream to simulate it already being registered
    addLogStream: (stream: any) => {
      addedStreams.push(stream);
      return !stream.key?.startsWith("service:");
    },
    removeLogStream: () => {},
  } as any;
}

function makeKv(callback: BuildCallback) {
  return {
    payloads: {
      consumeBuildCallback: async () => callback,
      listBuildQueue: async () => [],
      dequeueBuild: async () => {},
      saveDeploymentPayload: async () => {},
    },
    instanceCache: {
      decrementBuildSlots: async () => 0,
      untrackInFlightBuild: async () => {},
    },
  } as any;
}

const db = {
  deployments: {
    get: async () => ({ id: "dep-1", name: "my-svc" }),
    updateBuildResult: async () => {},
  },
  instances: { find: async () => null },
} as any;

const noopNotifier = { broadcast: async () => {}, notifyRefresh: () => {} } as any;
const noopJwt = { createNodeAccessToken: async () => "tok" } as any;
const conn = { clusterId: "cluster-1", instanceTag: "build-node-1", ws: { readyState: 1 } } as any;

describe("NodeMessageHandler — log stream registration on build complete", () => {
  it("registers deploy:<taskId> stream on the instance node after build", async () => {
    const sentTasks: any[] = [];
    const addedStreams: any[] = [];
    const handler = new NodeMessageHandler(makeConnectionManager({ sentTasks, addedStreams }), noopNotifier, db, makeKv(CALLBACK), noopJwt);

    await handler.handleMessage({ conn, message: taskResponseMsg("task-abc", { image: "reg/my-svc:1" }) });

    const deployStream = addedStreams.find(s => s.key === "deploy:task-abc");
    assert.ok(deployStream, "deploy:<taskId> stream must be registered");
    assert.equal(deployStream.meta.source, "deploy");
    assert.equal(deployStream.meta.clusterId, "cluster-1");
    assert.equal(deployStream.meta.deploymentId, "task-abc");
    assert.equal(deployStream.meta.serviceId, "my-svc");
    assert.equal(deployStream.path, "my-svc");

    const logTask = sentTasks.find(t => t.tag === "instance-a" && t.task.ID === deployStream.nodeStreamId);
    assert.ok(logTask, "log stream task must be sent to instance node carrying deploy stream id");
    assert.equal(logTask.task.Type, "logs/stream:post");
  });

  it("registers service:<name> persistent stream on the instance node after build", async () => {
    const sentTasks: any[] = [];
    const addedStreams: any[] = [];
    const handler = new NodeMessageHandler(makeConnectionManager({ sentTasks, addedStreams }), noopNotifier, db, makeKv(CALLBACK), noopJwt);

    await handler.handleMessage({ conn, message: taskResponseMsg("task-abc", { image: "reg/my-svc:1" }) });

    const runtimeStream = addedStreams.find(s => s.key === "service:my-svc");
    assert.ok(runtimeStream, "service:<name> runtime stream must be registered");
    assert.equal(runtimeStream.meta.source, "runtime");
    assert.equal(runtimeStream.meta.clusterId, "cluster-1");
    assert.equal(runtimeStream.duration, "live");
    assert.equal(runtimeStream.path, "my-svc");

    const runtimeTask = sentTasks.find(t => t.tag === "instance-a" && t.task.ID === runtimeStream.nodeStreamId);
    assert.ok(runtimeTask, "runtime log stream task must be sent to instance node");
    assert.equal(runtimeTask.task.Payload?.duration, "live");
  });

  it("service:<name> log task is NOT sent when addLogStream returns false (stream already active)", async () => {
    const sentTasks: any[] = [];
    const addedStreams: any[] = [];
    const handler = new NodeMessageHandler(makeConnectionManagerConditional(sentTasks, addedStreams), noopNotifier, db, makeKv(CALLBACK), noopJwt);

    await handler.handleMessage({ conn, message: taskResponseMsg("task-abc", { image: "reg/my-svc:1" }) });

    const runtimeTasks = sentTasks.filter(t => t.task.Payload?.duration === "live");
    assert.equal(runtimeTasks.length, 0, "no runtime log task must be sent when stream already exists");
  });

  it("both streams carry the correct node access token", async () => {
    const sentTasks: any[] = [];
    const addedStreams: any[] = [];
    const handler = new NodeMessageHandler(makeConnectionManager({ sentTasks, addedStreams }), noopNotifier, db, makeKv(CALLBACK), noopJwt);

    await handler.handleMessage({ conn, message: taskResponseMsg("task-xyz", { image: "reg/my-svc:2" }) });

    const logTasks = sentTasks.filter(t => t.task.Type === "logs/stream:post");
    assert.ok(logTasks.length >= 2, "at least deploy and runtime log tasks must be sent");
    for (const t of logTasks) {
      assert.equal(t.task.Payload?.token, "tok", "each log task must carry the node access token");
    }
  });
});
