// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Bindings, SystemStatus } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { AgentUpdateV1Schema, AgentStatusReportSchema, LATEST_COMPATIBILITY_DATE, type WSHandshakeResponse } from "@/types/agent";
import { isCompatible, getUpgradeLevel } from "@/lib/version";
import { ulid } from "ulid";

export class InstanceObject {
  private sockets: Set<WebSocket> = new Set();
  private handshakeComplete: Map<WebSocket, boolean> = new Map();
  private roles: Map<WebSocket, "agent" | "client"> = new Map();
  private statusWindow: { timestamp: number; system: SystemStatus }[] = [];
  private readonly maxWindowSize = 100;
  private logStreamSubscriptions: Map<WebSocket, { logType: string; lastOffset: number }> = new Map();
  private activeLogStreams: Map<string, string> = new Map(); // logType -> current streamId
  private rateLimits: Map<string, number[]> = new Map(); // In-memory rate limiting

  constructor(private state: DurableObjectState, private env: Bindings) {}

  private broadcastToClients(message: unknown): void {
    const payload = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (this.roles.get(socket) === "client") {
        try {
          socket.send(payload);
        } catch (err) {
          console.error("Failed to send message to client.", err);
        }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      const parts = url.pathname.split("/");
      const instanceId = parts.length >= 3 ? parts[parts.length - 2] : undefined;
      if (instanceId) {
        await this.state.storage.put("instanceId", instanceId);
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      this.state.acceptWebSocket(server);
      this.sockets.add(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Handle HTTP POST for adding tasks
    if (request.method === "POST" && url.pathname.endsWith("/tasks")) {
      try {
        const task = await request.json() as { id: string; type: string; payload: Record<string, unknown>; createdAt: number };
        await this.addTask(task);
        return new Response(JSON.stringify({ ok: true }), { 
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err) }), { 
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }

    const kind = payload?.kind as string | undefined;
    if (!kind) return;

    if (kind === "update") {
      this.roles.set(ws, "agent");

      // Cache payload, broadcast to clients
      if (payload && typeof payload === "object" && payload.update) {
        await this.state.storage.put("latestUpdate", payload.update);

        this.broadcastToClients({
          kind: "status_update",
          timestamp: Date.now(),
          update: payload.update,
        });
      }

      await this.handleAgentUpdate(ws, payload);
      return;
    }

    if (kind === "status_report") {
      await this.handleStatusReport(ws, payload);
      return;
    }

    if (kind === "client_subscribe") {
      this.roles.set(ws, "client");

      // Try to load latest update from storage (persisted across evictions)
      const latestUpdate = await this.state.storage.get("latestUpdate");
      if (latestUpdate) {
        ws.send(JSON.stringify({
          kind: "status_update",
          timestamp: Date.now(),
          update: latestUpdate,
        }));
        return;
      }

      // Fallback to the older SystemStatus window if populated
      const latest = this.statusWindow[this.statusWindow.length - 1];
      if (latest) {
        ws.send(JSON.stringify({
          kind: "status_update",
          system: latest.system,
          timestamp: latest.timestamp,
        }));
      }
      return;
    }

    if (kind === "log_subscribe") {
      this.roles.set(ws, "client");
      const logType = payload?.logType as string | undefined;
      const startOffset = (payload?.startOffset as number | undefined) || 0;
      
      if (!logType) {
        ws.send(JSON.stringify({ kind: "error", message: "logType required" }));
        return;
      }

      console.log(`log_subscribe: client subscribing to logType=${logType}, startOffset=${startOffset}`);
      
      this.logStreamSubscriptions.set(ws, { logType, lastOffset: startOffset });
      
      const activeStreamId = this.activeLogStreams.get(logType);
      ws.send(JSON.stringify({ 
        kind: "log_subscribed", 
        logType,
        streamId: activeStreamId || null,
        startOffset 
      }));
      return;
    }

    if (kind === "log_chunk") {
      const streamId = payload?.streamId as string | undefined;
      const logType = payload?.logType as string | undefined;
      const entries = (payload?.entries as { time: string; level: "DEBUG" | "INFO" | "WARN" | "ERROR"; msg: string }[] | undefined);
      const eof = payload?.eof as boolean | undefined;
      const hasMore = payload?.hasMore as boolean | undefined;
      const offset = payload?.offset as number | undefined;

      if (!streamId || !logType || !entries) return;

      // Rate limit log chunks: max 50 chunks per second per logType
      const rateLimitKey = `${streamId}:${logType}`;
      
      // Use in-memory rate limiting instead of KV to avoid high costs/limits
      if (!this.checkRateLimit(rateLimitKey, 1000, 50)) {
        console.log(`Rate limit hit for log stream ${streamId}, dropping chunk`);
        return;
      }

      // Track this as the active stream for this logType
      const currentActiveStreamId = this.activeLogStreams.get(logType);
      if (!currentActiveStreamId || currentActiveStreamId !== streamId) {
        this.activeLogStreams.set(logType, streamId);
        console.log(`Updated active stream for ${logType}: ${streamId}`);
      }

      const message = JSON.stringify({
        kind: "log_chunk",
        streamId,
        logType,
        entries,
        eof: eof || false,
        hasMore: hasMore || false,
        offset: offset || 0,
        timestamp: Date.now(),
      });

      let forwardedCount = 0;
      
      for (const socket of this.sockets) {
        const sub = this.logStreamSubscriptions.get(socket);
        if (sub && sub.logType === logType && offset && offset >= sub.lastOffset) {
          try {
            socket.send(message);
            sub.lastOffset = offset + (entries?.length || 0);
            forwardedCount++;
          } catch (err) {
            console.error("Failed to send log chunk to client", err);
          }
        }
      }
      
      if (forwardedCount === 0) {
        console.log(`log_chunk not forwarded: streamId=${streamId}, logType=${logType}, subscribers=${this.logStreamSubscriptions.size}`);
      } else {
        console.log(`log_chunk forwarded to ${forwardedCount} client(s)`);
      }
      return;
    }

    // Only agents need handshake for pull/ack
    if (this.roles.get(ws) === "agent" && !this.handshakeComplete.get(ws)) {
      ws.send(JSON.stringify({ kind: "error", message: "Handshake required" }));
      return;
    }

    if (kind === "pull") {
      await this.handlePull(ws);
      return;
    }

    if (kind === "ack") {
      const ids = Array.isArray(payload?.ids) ? (payload.ids as string[]) : [];
      if (!ids.length) return;
      
      // Delete completed tasks from DO storage
      const tasks = (await this.state.storage.get<any[]>("tasks")) || [];
      const remaining = tasks.filter(t => !ids.includes(t.id));
      await this.state.storage.put("tasks", remaining);
      await this.state.storage.delete("inflight");
      return;
    }
  }

  private checkRateLimit(key: string, windowMs: number, maxLimit: number): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    let timestamps = this.rateLimits.get(key) || [];
    
    // Cleanup old timestamps
    timestamps = timestamps.filter(ts => ts > windowStart);
    
    if (timestamps.length >= maxLimit) {
      // Update with filtered list even if blocked
      this.rateLimits.set(key, timestamps);
      return false;
    }
    
    timestamps.push(now);
    this.rateLimits.set(key, timestamps);
    return true;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const sub = this.logStreamSubscriptions.get(ws);
    
    this.sockets.delete(ws);
    this.handshakeComplete.delete(ws);
    this.roles.delete(ws);
    this.logStreamSubscriptions.delete(ws);
    
    // Check if there are other clients subscribed to this logType
    if (sub) {
      const hasOtherClients = Array.from(this.logStreamSubscriptions.values())
        .some(s => s.logType === sub.logType);
      
      if (!hasOtherClients) {
        console.log(`No more clients for logType=${sub.logType}, cleaning up active stream`);
        this.activeLogStreams.delete(sub.logType);
        // TODO: Send cancel signal to daemon when supported
      }
    }
    
    if (this.sockets.size === 0) {
      const inflight = await this.state.storage.get<string[]>("inflight");
      if (Array.isArray(inflight) && inflight.length > 0) {
        await this.state.storage.delete("inflight");
      }
    }
  }

  private async handleStatusReport(ws: WebSocket, payload: any): Promise<void> {
    const validation = AgentStatusReportSchema.safeParse(payload);
    if (!validation.success) {
      ws.send(JSON.stringify({ kind: "error", message: "Invalid status_report schema" }));
      return;
    }

    const report = validation.data;
    const entry: { timestamp: number; system: SystemStatus } = {
      timestamp: Date.now(),
      system: report.system as SystemStatus,
    };

    this.statusWindow.push(entry);
    if (this.statusWindow.length > this.maxWindowSize) {
      this.statusWindow.shift();
    }

    const message = JSON.stringify({
      kind: "status_update",
      system: entry.system,
      timestamp: entry.timestamp,
    });

    for (const socket of this.sockets) {
      if (this.roles.get(socket) === "client") {
        socket.send(message);
      }
    }
  }

  /**
   * Handles incoming messages from the agent.
   */
  private async handleAgentUpdate(ws: WebSocket, payload: any): Promise<void> {
    const validation = AgentUpdateV1Schema.safeParse(payload);
    if (!validation.success) {
      ws.send(JSON.stringify({ kind: "error", message: "Invalid agent_update schema" }));
      return;
    }

    const update = validation.data;

    const alreadyHandshaken = this.handshakeComplete.get(ws) === true;

    // ALLOWED: One-time handshake only, not per-message
    const kv = KVStore.fromCloudflare(this.env.BASE_KV);

    if (!alreadyHandshaken) {
      if (!isCompatible(update.compatibility_date, LATEST_COMPATIBILITY_DATE)) {
        const response: WSHandshakeResponse = {
          kind: "hello",
          status: "rejected",
          reason: "incompatible",
          required: LATEST_COMPATIBILITY_DATE,
          received: update.compatibility_date,
        };
        ws.send(JSON.stringify(response));
        ws.close(1008, "Incompatible version");
        return;
      }

      let upgradeInfo: { level: "major" | "minor"; latest: string } | undefined;
      try {
        const latest = await kv.getLatestVersion();
        if (latest) {
          const upgradeLevel = getUpgradeLevel(latest, update.version);
          if (upgradeLevel !== "none") {
            upgradeInfo = { level: upgradeLevel, latest };
          }
        }
      } catch (err) {
        console.error("Failed to determine latest release version", err);
      }

      this.handshakeComplete.set(ws, true);
      const response: WSHandshakeResponse = {
        kind: "hello",
        status: "accepted",
        ...(upgradeInfo && { upgrade_available: upgradeInfo }),
      };
      ws.send(JSON.stringify(response));
    }
  }

  /**
   * Handles outgoing messages to the agent.
   */
  private async handlePull(ws: WebSocket): Promise<void> {
    const instanceId = (await this.state.storage.get<string>("instanceId")) || "";
    if (!instanceId) return;

    // Get tasks from DO storage instead of KV
    const allTasks = (await this.state.storage.get<any[]>("tasks")) || [];
    const now = Date.now();
    
    // Filter for pending or expired leased tasks
    const tasks = allTasks.filter(
      t => t.status === "pending" || (t.status === "leased" && t.leaseUntil <= now)
    ).slice(0, 50);

    if (tasks.length > 0) {
      const ids = tasks.map((t: any) => t.id);
      
      // Lease tasks in DO storage
      const leaseUntil = now + 300000; // 5 min lease
      const updatedTasks = allTasks.map(t => {
        if (ids.includes(t.id)) {
          return { ...t, status: "leased", leaseUntil, updatedAt: now };
        }
        return t;
      });
      
      await this.state.storage.put("tasks", updatedTasks);
      await this.state.storage.put("inflight", ids);
    }

    const items = tasks.map((t: any) => ({
      id: t.id,
      requestId: t.id,
      type: t.type,
      payload: (t.payload || {}) as Record<string, unknown>,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));

    // Always send a response, even if empty
    ws.send(
      JSON.stringify({
        kind: "task",
        requestId: ulid(),
        items,
      }),
    );
  }

  /**
   * Add a task to this instance's queue (called from Worker)
   */
  async addTask(task: { id: string; type: string; payload: Record<string, unknown>; createdAt: number }): Promise<void> {
    const tasks = (await this.state.storage.get<any[]>("tasks")) || [];
    tasks.push({
      ...task,
      status: "pending",
      updatedAt: task.createdAt,
    });
    await this.state.storage.put("tasks", tasks);
  }
}
