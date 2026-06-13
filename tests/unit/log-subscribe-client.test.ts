// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClientMessageHandler } from "@/services/websocket/handlers/client-handler.js";

function logSubscribeMsg(path: string, overrides: Record<string, any> = {}) {
  return {
    kind: "log_subscribe",
    streamId: "sub-1",
    path,
    duration: "24h",
    startFrom: 0,
    ...overrides,
  } as any;
}

function makeConn(clusterId = "cluster-1") {
  return {
    clusterId,
    ws: { send: () => {}, readyState: 1 } as any,
    connectionId: "conn-1",
    role: "client" as const,
    connectedAt: Date.now(),
  } as any;
}

function makeConnectionManager(opts: {
  existingStreams?: Record<string, any>;
  sentTasks?: any[];
  joinedStreams?: string[];
} = {}) {
  const joinedStreams = opts.joinedStreams ?? [];
  const sentTasks = opts.sentTasks ?? [];
  const streams = opts.existingStreams ?? {};
  return {
    updateActivity: () => {},
    getLogStreamByPath: (path: string) => streams[path] ?? undefined,
    addClientToLogStream: (path: string, _ws: any) => { joinedStreams.push(path); return !!streams[path]; },
    addLogStream: (stream: any) => { streams[stream.key] = stream; return true; },
    removeLogStream: () => {},
    sendTask: (tag: string, task: any) => { sentTasks.push({ tag, task }); return true; },
    getNodeConnections: () => [],
    findBuildDeployStreamsForService: (_serviceId: string) => [],
  } as any;
}

function makeDb(opts: { deployment?: any; instance?: any } = {}) {
  return {
    deployments: {
      get: async (_id: string) => opts.deployment ?? null,
    },
    instances: {
      getForCluster: async () => opts.instance ?? null,
      find: async () => opts.instance ?? null,
    },
    clusters: {
      find: async () => ({ id: "cluster-1", poolInstanceId: null }),
    },
  } as any;
}

const noopJwt = { createNodeAccessToken: async () => "tok" } as any;
const noopKv = {
  instanceCache: { getPoolInstance: async () => null },
  nodeState: { get: async () => null },
} as any;
const noopTerminal = {} as any;

function makeHandler(cm: any, db: any) {
  return new ClientMessageHandler({
    connectionManager: cm,
    kv: noopKv,
    db,
    jwtService: noopJwt,
    dployrdService: { createLogStreamTask: (o: any) => ({ ID: o.streamId, Type: "logs/stream:post", Payload: o, Status: "pending" }) } as any,
    terminalManager: noopTerminal,
    loki: undefined,
  });
}

describe("ClientMessageHandler — handleLogSubscribe (deployment path)", () => {
  it("joins build:<deploymentId> stream when active", async () => {
    const joinedStreams: string[] = [];
    const buildStream = { key: "build:dep-1", clients: new Set(), nodeStreamId: "ns-1" };
    const cm = makeConnectionManager({ existingStreams: { "build:dep-1": buildStream }, joinedStreams });
    const db = makeDb({ deployment: { id: "dep-1", name: "my-svc" } });
    const handler = makeHandler(cm, db);

    await handler.handleMessage(makeConn(), logSubscribeMsg("dep-1"));

    assert.ok(joinedStreams.includes("build:dep-1"), "client must join the active build stream");
  });

  it("joins deploy:<deploymentId> when build stream is gone but deploy stream is active", async () => {
    const joinedStreams: string[] = [];
    const deployStream = { key: "deploy:dep-1", clients: new Set(), nodeStreamId: "ns-2" };
    const cm = makeConnectionManager({ existingStreams: { "deploy:dep-1": deployStream }, joinedStreams });
    const db = makeDb({ deployment: { id: "dep-1", name: "my-svc" } });
    const handler = makeHandler(cm, db);

    await handler.handleMessage(makeConn(), logSubscribeMsg("dep-1"));

    assert.ok(joinedStreams.includes("deploy:dep-1"), "client must join the active deploy stream");
    assert.equal(joinedStreams.includes("build:dep-1"), false, "must not attempt to join the non-existent build stream");
  });

  it("does not join any stream when both build and deploy streams are inactive (graceful)", async () => {
    const joinedStreams: string[] = [];
    const cm = makeConnectionManager({ existingStreams: {}, joinedStreams });
    const db = makeDb({ deployment: { id: "dep-1", name: "my-svc" } });
    const handler = makeHandler(cm, db);

    await handler.handleMessage(makeConn(), logSubscribeMsg("dep-1"));

    assert.equal(joinedStreams.length, 0, "no stream join attempt must be made when neither phase stream is active");
  });

  it("returns NOT_FOUND error when deployment does not exist", async () => {
    const errors: any[] = [];
    const conn = makeConn();
    conn.ws.send = (raw: string) => { errors.push(JSON.parse(raw)); };
    const cm = makeConnectionManager();
    const db = makeDb({ deployment: null });
    const handler = makeHandler(cm, db);

    await handler.handleMessage(conn, logSubscribeMsg("unknown-dep"));

    assert.ok(errors.length > 0, "error must be sent to client");
    assert.equal(errors[0].code, 2001, "error code must be WSErrorCode.NOT_FOUND (2001)");
  });
});

describe("ClientMessageHandler — handleLogSubscribe (service/runtime path)", () => {
  it("sends log_subscribed and dispatches a dployrd log stream task to the node", async () => {
    const sentTasks: any[] = [];
    const responses: any[] = [];
    const conn = makeConn();
    conn.ws.send = (raw: string) => { responses.push(JSON.parse(raw)); };
    const cm = makeConnectionManager({ sentTasks });
    const db = makeDb({ instance: { tag: "instance-a", id: "inst-1" } });
    (db as any).instances.find = async () => ({ tag: "instance-a" });
    (db as any).clusters = { find: async () => ({ id: "cluster-1", poolInstanceId: null }) };
    const handler = makeHandler(cm, db);

    await handler.handleMessage(conn, logSubscribeMsg("service:my-svc"));

    // dployrd task must be sent for live log streaming
    const logTasks = sentTasks.filter(t => t.task?.Type === "logs/stream:post");
    assert.equal(logTasks.length, 1, "one dployrd log stream task must be sent for runtime logs");

    // Client must receive log_subscribed confirmation
    const subscribed = responses.find(r => r.kind === "log_subscribed");
    assert.ok(subscribed, "log_subscribed must be sent to client");
    assert.equal(subscribed.path, "service:my-svc");
  });

  it("returns NOT_FOUND error when no instance is available for the cluster", async () => {
    const errors: any[] = [];
    const conn = makeConn();
    conn.ws.send = (raw: string) => { errors.push(JSON.parse(raw)); };
    const cm = makeConnectionManager();
    const db = makeDb({ instance: null });
    (db as any).instances.find = async () => null;
    (db as any).clusters = { find: async () => ({ id: "cluster-1", poolInstanceId: null }) };
    const handler = makeHandler(cm, db);

    await handler.handleMessage(conn, logSubscribeMsg("service:my-svc"));

    assert.ok(errors.length > 0, "error must be sent to client");
    assert.equal(errors[0].code, 5000, "error code must be WSErrorCode.INTERNAL_ERROR (5000)");
  });
});
