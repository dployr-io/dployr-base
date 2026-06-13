// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeMessageHandler } from "@/services/websocket/handlers/node-handler.js";
import type { BuildCallback, BuildQueueEntry } from "@/lib/db/store/kv/payload.js";


const CALLBACK: BuildCallback = {
  callbackInstanceTag: "instance-a",
  buildNodeTag: "build-node-1",
  clusterId: "cluster-1",
  fingerprint: "fp-deadbeef",
  payload: { name: "my-svc", user_id: "u1", type: "web", source: "remote", runtime: "nodejs", force_rebuild: false } as any,
};

const QUEUED_ENTRY: BuildQueueEntry = {
  taskId: "queued-task-1",
  clusterId: "cluster-1",
  callbackInstanceTag: "instance-a",
  fingerprint: "fp-queued",
  payload: CALLBACK.payload,
  tier: "hobby",
  enqueuedAt: Date.now(),
};

function taskResponseMsg(taskId: string, success: boolean, data?: any) {
  return { kind: "task_response", taskId, success, data } as any;
}

function makeConnectionManager(opts: {
  pendingRequest?: any;
  sentTasks?: Array<{ tag: string; task: any }>;
} = {}) {
  const sent = opts.sentTasks ?? [];
  return {
    updateActivity: () => {},
    getPendingRequest: (_taskId: string) => opts.pendingRequest ?? null,
    routeResponseToClient: () => {},
    getFileWatchSubscribers: () => null,
    getConnections: () => [],
    sendTask: (tag: string, task: any) => {
      sent.push({ tag, task });
      return true;
    },
    removeLogStream: (_key: string) => {},
    addLogStream: (_stream: any) => true,
  } as any;
}

function makeKv(opts: {
  callback?: BuildCallback | null;
  queue?: BuildQueueEntry[];
  savedCallbacks?: Array<{ taskId: string; cb: any }>;
  slotOps?: string[];
} = {}) {
  const savedCallbacks = opts.savedCallbacks ?? [];
  const slotOps = opts.slotOps ?? [];
  return {
    payloads: {
      consumeBuildCallback: async (_taskId: string) => opts.callback ?? null,
      saveBuildCallback: async (taskId: string, cb: any) => {
        savedCallbacks.push({ taskId, cb });
      },
      listBuildQueue: async () => opts.queue ?? [],
      dequeueBuild: async () => {},
      saveDeploymentPayload: async () => {},
    },
    instanceCache: {
      decrementBuildSlots: async (tag: string) => {
        slotOps.push(`decrement:${tag}`);
        return 0;
      },
      incrementBuildSlots: async (tag: string) => {
        slotOps.push(`increment:${tag}`);
        return 1;
      },
      getBuildSlots: async () => 0,
      trackInFlightBuild: async (tag: string, entry: any) => {
        slotOps.push(`track:${tag}:${entry?.taskId}`);
      },
      untrackInFlightBuild: async (tag: string, taskId: string) => {
        slotOps.push(`untrack:${tag}:${taskId}`);
      },
    },
  } as any;
}

function makeDb(opts: {
  deployment?: { id: string; name: string } | null;
  buildResultCalls?: Array<{ id: string; buildFingerprint: string; image: string }>;
  instance?: any;
} = {}) {
  const buildResultCalls = opts.buildResultCalls ?? [];
  return {
    deployments: {
      get: async (_filter: any) => opts.deployment ?? null,
      updateBuildResult: async (id: string, result: any) => {
        buildResultCalls.push({ id, ...result });
      },
    },
    instances: {
      find: async () => opts.instance ?? null,
    },
  } as any;
}

const noopNotifier = { broadcast: async () => {}, notifyRefresh: () => {} } as any;
const noopJwt = { createNodeAccessToken: async () => "generated-token" } as any;


describe("NodeMessageHandler — build complete (task_response with callback)", () => {
  it("successful build dispatches publish task to callback instance with a token", async () => {
    const sentTasks: Array<{ tag: string; task: any }> = [];
    const cm = makeConnectionManager({ sentTasks });
    const kv = makeKv({ callback: CALLBACK });
    const buildResultCalls: any[] = [];
    const db = makeDb({
      deployment: { id: "dep-123", name: "my-svc" },
      buildResultCalls,
    });

    const handler = new NodeMessageHandler(cm, noopNotifier, db, kv, noopJwt);
    await handler.handleMessage({
      conn: { clusterId: "cluster-1", instanceTag: "build-node-1", ws: { readyState: 1 } } as any,
      message: taskResponseMsg("build-task-1", true, { image: "registry.do.com/dployr/my-svc:1234" }),
    });

    const publishTask = sentTasks.find((t) => t.tag === "instance-a");
    assert.ok(publishTask, "publish task must be sent to the callback instance");
    assert.equal(publishTask!.task.Type, "builds/publish:post");
    assert.equal(publishTask!.task.Payload.image, "registry.do.com/dployr/my-svc:1234");
    assert.equal(publishTask!.task.Payload.token, "generated-token", "publish task must carry auth token");
  });

  it("successful build persists fingerprint and image on the deployment record", async () => {
    const buildResultCalls: any[] = [];
    const kv = makeKv({ callback: CALLBACK });
    const db = makeDb({ deployment: { id: "dep-456", name: "my-svc" }, buildResultCalls });
    const handler = new NodeMessageHandler(makeConnectionManager(), noopNotifier, db, kv, noopJwt);

    await handler.handleMessage({
      conn: { clusterId: "c", instanceTag: "build-node-1", ws: { readyState: 1 } } as any,
      message: taskResponseMsg("t1", true, { image: "registry.do.com/dployr/my-svc:999" }),
    });

    assert.equal(buildResultCalls.length, 1, "updateBuildResult must be called once");
    assert.equal(buildResultCalls[0].id, "dep-456");
    assert.equal(buildResultCalls[0].image, "registry.do.com/dployr/my-svc:999");
    assert.equal(buildResultCalls[0].buildFingerprint, CALLBACK.fingerprint);
  });

  it("build slot is released on the build node after build completes", async () => {
    const slotOps: string[] = [];
    const kv = makeKv({ callback: CALLBACK, slotOps });
    const db = makeDb({ deployment: { id: "dep-1", name: "my-svc" } });
    const handler = new NodeMessageHandler(makeConnectionManager(), noopNotifier, db, kv, noopJwt);

    await handler.handleMessage({
      conn: { clusterId: "c", instanceTag: "build-node-1", ws: { readyState: 1 } } as any,
      message: taskResponseMsg("t1", true, { image: "img:1" }),
    });

    assert.ok(slotOps.includes("decrement:build-node-1"), "slot must be decremented on the build node after completion");
  });

  it("build result missing image — no publish dispatched, slot still released", async () => {
    const sentTasks: Array<{ tag: string; task: any }> = [];
    const slotOps: string[] = [];
    const kv = makeKv({ callback: CALLBACK, slotOps });
    const db = makeDb();
    const handler = new NodeMessageHandler(makeConnectionManager({ sentTasks }), noopNotifier, db, kv, noopJwt);

    await handler.handleMessage({
      conn: { clusterId: "c", instanceTag: "build-node-1", ws: { readyState: 1 } } as any,
      message: taskResponseMsg("t1", true, {}), // no image in data
    });

    assert.equal(sentTasks.length, 0, "no task should be dispatched when image is missing");
    assert.ok(slotOps.includes("decrement:build-node-1"), "slot must still be released even with no image");
  });

  it("queued build is dispatched when a slot is freed after build complete", async () => {
    const sentTasks: Array<{ tag: string; task: any }> = [];
    const slotOps: string[] = [];
    const kv = makeKv({ callback: CALLBACK, queue: [QUEUED_ENTRY], slotOps });
    const db = makeDb({ deployment: { id: "dep-1", name: "my-svc" } });
    const handler = new NodeMessageHandler(makeConnectionManager({ sentTasks }), noopNotifier, db, kv, noopJwt);

    await handler.handleMessage({
      conn: { clusterId: "c", instanceTag: "build-node-1", ws: { readyState: 1 } } as any,
      message: taskResponseMsg("t1", true, { image: "img:1" }),
    });

    const queuedDispatch = sentTasks.find((t) => t.tag === "build-node-1" && t.task.ID === QUEUED_ENTRY.taskId);
    assert.ok(queuedDispatch, "queued build task must be dispatched to the build node after slot is freed");
    assert.equal(queuedDispatch!.task.Type, "builds:post");
  });

  it("no callback for taskId — falls through to normal client routing", async () => {
    const kv = makeKv({ callback: null });
    const db = makeDb();
    let routedToClient = false;
    const cm = makeConnectionManager({
      pendingRequest: { ws: { send: () => {} }, requestId: "req-1", kind: "deploy" },
    });
    (cm as any).routeResponseToClient = () => { routedToClient = true; };

    const handler = new NodeMessageHandler(cm, noopNotifier, db, kv, noopJwt);
    await handler.handleMessage({
      conn: { clusterId: "c", instanceTag: "node-1", ws: { readyState: 1 } } as any,
      message: taskResponseMsg("t1", true, { status: "ok" }),
    });

    assert.ok(routedToClient, "response with a pending client request must be routed to the client, not treated as build complete");
  });
});
