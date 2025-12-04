// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { IDurableObjectAdapter, IDurableObjectStub } from '@/lib/context.js';
import type { Bindings, SystemStatus } from '@/types/index.js';
import { KVStore } from '@/lib/db/store/kv.js';
import { AgentUpdateV1Schema, AgentStatusReportSchema, LATEST_COMPATIBILITY_DATE, type WSHandshakeResponse } from '@/types/agent.js';
import { isCompatible, getUpgradeLevel } from '@/lib/version.js';
import { LazyMap } from '@/lib/lazy-map.js';
import { ulid } from 'ulid';
import type { IKVAdapter } from '@/lib/storage/kv.interface.js';

/**
 * Self-hosted implementation of Durable Object functionality
 * Manages WebSocket connections and state in-memory per instance
 */
export class NodeDurableObjectAdapter implements IDurableObjectAdapter {
  private instances: Map<string, NodeInstanceObject> = new Map();

  constructor(private env: Bindings, private kvAdapter: IKVAdapter) {}

  idFromName(name: string): string {
    return name; // In Node, the ID is just the name
  }

  get(id: string): NodeInstanceObject {
    let instance = this.instances.get(id);
    if (!instance) {
      instance = new NodeInstanceObject(id, this.env, this.kvAdapter);
      this.instances.set(id, instance);
    }
    return instance;
  }
}

/**
 * Self-hosted implementation of a single Durable Object instance
 * Mimics the behavior of Cloudflare's InstanceObject
 */
class NodeInstanceObject implements IDurableObjectStub {
  private sockets: Set<WebSocket> = new Set();
  private handshakeComplete: Map<WebSocket, boolean> = new Map();
  private roles: Map<WebSocket, "agent" | "client"> = new Map();
  private statusWindow: { timestamp: number; system: SystemStatus }[] = [];
  private readonly maxWindowSize = 100;
  private logStreamSubscriptions: Map<WebSocket, { path: string; lastOffset: number }> = new Map();
  private activeLogStreams: LazyMap<string, string>;
  private rateLimits: LazyMap<string, number[]>;
  private logHistory: LazyMap<string, any[]>;
  
  // In-memory storage (mimics DurableObjectState.storage)
  private storage: Map<string, any> = new Map();
  private tasks: any[] = [];

  constructor(
    private instanceId: string,
    private env: Bindings,
    private kvAdapter: IKVAdapter
  ) {
    // Initialize LazyMaps for automatic memory management
    this.activeLogStreams = new LazyMap(1000 * 60 * 10); // 10 min TTL
    this.rateLimits = new LazyMap(1000 * 5); // 5 sec TTL
    this.logHistory = new LazyMap(1000 * 60 * 5); // 5 min TTL
    this.storage.set('instanceId', instanceId);
  }

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
      return this.handleWebSocketUpgrade(request);
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

  private handleWebSocketUpgrade(request: Request): Response {
    // Node.js WebSocket upgrade using the 'ws' library pattern
    // This requires the server to handle the upgrade
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const instanceId = parts.length >= 3 ? parts[parts.length - 2] : undefined;
    
    if (instanceId) {
      this.storage.set("instanceId", instanceId);
    }

    // For Node.js, we need to return a special response that signals
    // the server to upgrade the connection
    // The actual WebSocket handling will be done by the server middleware
    return new Response(null, {
      status: 101,
      statusText: 'Switching Protocols',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'X-Instance-Id': this.instanceId,
      }
    });
  }

  /**
   * Register a WebSocket connection (called by server after upgrade)
   */
  acceptWebSocket(ws: WebSocket): void {
    this.sockets.add(ws);

    ws.addEventListener('message', (event) => {
      this.webSocketMessage(ws, event.data).catch(err => {
        console.error('WebSocket message error:', err);
      });
    });

    ws.addEventListener('close', () => {
      this.webSocketClose(ws).catch(err => {
        console.error('WebSocket close error:', err);
      });
    });

    ws.addEventListener('error', (err) => {
      console.error('WebSocket error:', err);
      this.webSocketClose(ws).catch(e => {
        console.error('Error during WebSocket cleanup:', e);
      });
    });
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
        this.storage.set("latestUpdate", payload.update);

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

      // Try to load latest update from storage
      const latestUpdate = this.storage.get("latestUpdate");
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
      const path = payload?.path as string | undefined;
      const startFrom = (payload?.startFrom as number | undefined) ?? -1;

      if (!path) return;

      this.logStreamSubscriptions.set(ws, { path, lastOffset: startFrom });
      console.log(`Client subscribed to logs: path=${path}, startFrom=${startFrom}`);

      // Send recent history if available
      const history = this.logHistory.get(path);
      if (history && history.length > 0) {
        for (const chunk of history) {
          if (chunk.offset === undefined || chunk.offset >= startFrom) {
            try {
              ws.send(JSON.stringify({ kind: "log_chunk", payload: chunk }));
            } catch (err) {
              console.error("Failed to send historical chunk", err);
            }
          }
        }
      }

      // Notify daemon to start streaming if this is the first subscriber for this path
      const activeStreamId = this.activeLogStreams.get(path);
      if (!activeStreamId) {
        // Send task to daemon to start streaming
        const streamId = `${this.instanceId}:${path}`;
        console.log(`Starting new log stream for path=${path}, streamId=${streamId}`);
        
        // Send task via agent WebSocket
        for (const socket of this.sockets) {
          if (this.roles.get(socket) === "agent") {
            try {
              socket.send(JSON.stringify({
                kind: "task",
                payload: {
                  id: ulid(),
                  type: "logs/stream:post",
                  payload: {
                    streamId,
                    path,
                    mode: "tail",
                    startFrom,
                  },
                },
              }));
              console.log(`Sent logs/stream:post task to daemon for path=${path}`);
            } catch (err) {
              console.error("Failed to send task to daemon", err);
            }
          }
        }
      }
      return;
    }

    if (kind === "log_chunk") {
      const streamId = payload?.streamId as string | undefined;
      const path = payload?.path as string | undefined;
      const entries = (payload?.entries as { time: string; level: "DEBUG" | "INFO" | "WARN" | "ERROR"; msg: string }[] | undefined);
      const eof = payload?.eof as boolean | undefined;
      const hasMore = payload?.hasMore as boolean | undefined;
      const offset = payload?.offset as number | undefined;

      if (!streamId || !path || !entries) return;

      this.activeLogStreams.set(path, streamId);

      // Rate limit log chunks: max 500 chunks per second per path
      const rateLimitKey = `${streamId}:${path}`;
      
      if (!this.checkRateLimit(rateLimitKey, 1000, 5000)) {
        console.log(`Rate limit hit for log stream ${streamId}, dropping chunk`);
        return;
      }
      
      // Store in history (limit to 50 chunks per path)
      const history = this.logHistory.get(path) || [];
      history.push({ streamId, entries, offset, timestamp: Date.now() });
      if (history.length > 50) {
        history.shift();
      }
      this.logHistory.set(path, history);

      // Forward to subscribers
      const message = JSON.stringify({ kind: "log_chunk", payload });
      let forwardedCount = 0;
      
      for (const socket of this.sockets) {
        const sub = this.logStreamSubscriptions.get(socket);
        if (sub && sub.path === path) {
          // Forward if offset is valid and >= lastOffset
          if (offset !== undefined && offset >= sub.lastOffset) {
            try {
              socket.send(message);
              sub.lastOffset = offset + (entries?.length || 0);
              forwardedCount++;
            } catch (err) {
              console.error("Failed to send log chunk to client", err);
            }
          }
        }
      }
      
      // Clean up active stream on EOF
      if (eof) {
        console.log(`Stream ended (EOF) for ${path}: ${streamId}`);
        this.activeLogStreams.delete(path);
      }
      
      if (forwardedCount === 0) {
        console.log(`log_chunk not forwarded: streamId=${streamId}, path=${path}, subscribers=${this.logStreamSubscriptions.size}`);
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
      
      // Delete completed tasks from storage
      this.tasks = this.tasks.filter(t => !ids.includes(t.id));
      this.storage.delete("inflight");
      return;
    }
  }

  private checkRateLimit(key: string, windowMs: number, maxLimit: number): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    let timestamps = this.rateLimits.get(key) || [];
    
    // Cleanup old timestamps
    timestamps = timestamps.filter((ts: number) => ts > windowStart);
    
    if (timestamps.length >= maxLimit) {
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
    
    // Check if there are other clients still subscribed to this path
    let hasOtherClients = false;
    for (const otherSocket of this.sockets) {
      if (otherSocket !== ws) {
        const otherSub = this.logStreamSubscriptions.get(otherSocket);
        if (otherSub && otherSub.path === sub?.path) {
          hasOtherClients = true;
          break;
        }
      }
    }

    if (!hasOtherClients && sub) {
      console.log(`No more clients for path=${sub.path}, cleaning up`);
      this.activeLogStreams.delete(sub.path);
      this.logHistory.delete(sub.path);
      // Note: Daemon streams will naturally stop when context is cancelled on WS disconnect
    }
    
    if (this.sockets.size === 0) {
      const inflight = this.storage.get("inflight");
      if (Array.isArray(inflight) && inflight.length > 0) {
        this.storage.delete("inflight");
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

  private async handleAgentUpdate(ws: WebSocket, payload: any): Promise<void> {
    const validation = AgentUpdateV1Schema.safeParse(payload);
    if (!validation.success) {
      ws.send(JSON.stringify({ kind: "error", message: "Invalid agent_update schema" }));
      return;
    }

    const update = validation.data;
    const alreadyHandshaken = this.handshakeComplete.get(ws) === true;

    const kv = new KVStore(this.kvAdapter);

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

  private async handlePull(ws: WebSocket): Promise<void> {
    const instanceId = this.storage.get("instanceId") || "";
    if (!instanceId) return;

    const now = Date.now();
    
    // Filter for pending or expired leased tasks
    const tasks = this.tasks.filter(
      t => t.status === "pending" || (t.status === "leased" && t.leaseUntil <= now)
    ).slice(0, 50);

    if (tasks.length > 0) {
      const ids = tasks.map((t: any) => t.id);
      
      // Lease tasks
      const leaseUntil = now + 300000; // 5 min lease
      this.tasks = this.tasks.map(t => {
        if (ids.includes(t.id)) {
          return { ...t, status: "leased", leaseUntil, updatedAt: now };
        }
        return t;
      });
      
      this.storage.set("inflight", ids);
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

  async addTask(task: { id: string; type: string; payload: Record<string, unknown>; createdAt: number }): Promise<void> {
    this.tasks.push({
      ...task,
      status: "pending",
      updatedAt: task.createdAt,
    });
  }
}
