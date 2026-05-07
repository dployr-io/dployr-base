// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createServer, Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Buffer } from "buffer";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import type { Hono } from "hono";
import { initializeAdapters, type Adapters } from "@/lib/config/bootstrap.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import type { Session } from "@/types/index.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Server");

export class WebSocketService {
  private server: Server;
  private wss: WebSocketServer;
  private adapters: Adapters | null = null;

  constructor(private app: Hono<any, any, any>) {
    this.server = this.createHttpServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.setupUpgradeHandler();
  }

  /**
   * Initialize adapters and start the server
   */
  async start(): Promise<void> {
    this.adapters = await initializeAdapters();
    const config = this.adapters.config;
    this.server.listen(config.server.port, config.server.host, () => {
      log.info(`Dployr Base running on http://${config.server.host}:${config.server.port}`);
    });
    this.setupGracefulShutdown();
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      log.info(`Received ${signal}, starting graceful shutdown...`);

      // Stop accepting new connections
      this.wss.close();

      // Shutdown WebSocket handler
      if (this.adapters?.ws) {
        this.adapters.ws.shutdown();
      }

      // Close HTTP server
      this.server.close(() => {
        log.info("HTTP server closed");
        process.exit(0);
      });

      // Force exit after 10 seconds
      setTimeout(() => {
        log.error("Forced shutdown after timeout");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  private createHttpServer(): Server {
    return createServer(async (req, res) => {
      const upgradeHeader = req.headers["upgrade"];
      if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
        log.info("WebSocket upgrade request detected, deferring to upgrade handler");
        return;
      }

      // Collect request body for non-GET/HEAD requests
      let body;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }

      const response = await this.app.fetch(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers: req.headers as any,
          body: body,
        }),
      );

      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    });
  }

  /**
   * Resolve connection details for nodes or clients
   * Returns { connectionKey, clusterId, instanceTag }
   * - connectionKey: key to register under in connections map
   * - clusterId: actual cluster ID (for notifications, undefined for pool nodes)
   * - instanceTag: instance tag (only for nodes)
   */
  private async resolveConnectionDetails(
    role: "node" | "client",
    url: URL,
  ): Promise<{ connectionKey: string; clusterId?: string; instanceTag?: string } | null> {
    if (role === "node") {
      if (!this.adapters?.db) return null;

      const instanceId = url.searchParams.get("instanceId");
      const instanceName = url.searchParams.get("instanceName");

      if (!instanceId && !instanceName) return null;

      const db = new DatabaseStore(this.adapters.db);
      const instance = await db.instances.find(instanceId ? { id: instanceId } : { tag: instanceName! });

      if (!instance) return null;

      return {
        connectionKey: instance.kind === "pool" ? `pool:${instance.tag}` : instance.tag,
        clusterId: instance.kind === "dedicated" ? instance.clusterId || undefined : undefined,
        instanceTag: instance.tag,
      };
    } else {
      // Client connection
      const clusterId = url.searchParams.get("clusterId");
      return clusterId ? { connectionKey: clusterId, clusterId } : null;
    }
  }

  private setupUpgradeHandler(): void {
    this.server.on("upgrade", async (message: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(message.url || "", `http://${message.headers.host}`);

      // Handle terminal relay endpoint - node outbound connections
      // Matches: /v1/terminal/ws?sessionId=...
      if (url.pathname === "/v1/terminal/ws") {
        const sessionId = url.searchParams.get("sessionId");

        if (!sessionId) {
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          socket.destroy();
          return;
        }

        const authHeader = message.headers["authorization"] || message.headers["Authorization"];
        const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        if (!auth || !auth.startsWith("Bearer ")) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        if (!this.adapters?.ws) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(message, socket, head, (ws: WebSocket) => {
          const accepted = this.adapters!.ws.acceptTerminalConnection(sessionId!, ws);
          if (!accepted) {
            ws.close(1008, "Session not found or expired");
          }
        });
        return;
      }

      // Handle cluster WebSocket streams
      // Matches: /v1/instances/stream OR /v1/node/ws
      if (url.pathname.match(/\/v1\/(instances\/stream|node\/ws)$/)) {
        const role = url.pathname.includes("/node/ws") ? "node" : "client";

        const connectionDetails = await this.resolveConnectionDetails(role, url);
        if (!connectionDetails || !this.adapters?.ws) {
          const statusCode = !connectionDetails ? (role === "node" ? "404" : "400") : "400";
          socket.write(`HTTP/1.1 ${statusCode} ${statusCode === "404" ? "Not Found" : "Bad Request"}\r\n\r\n`);
          socket.destroy();
          return;
        }

        const { connectionKey, clusterId, instanceTag } = connectionDetails;

        // Validate auth token for node endpoint
        if (role === "node") {
          const authHeader = message.headers["authorization"] || message.headers["Authorization"];
          const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
          if (!auth || !auth.startsWith("Bearer ")) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
        }

        // Get session for client connections
        let session: Session | undefined;
        if (role === "client" && this.adapters?.kv) {
          const cookies = message.headers.cookie || "";
          const sessionId = cookies
            .split(";")
            .map((c) => c.trim())
            .find((c) => c.startsWith("session="))
            ?.split("=")[1];

          if (sessionId) {
            const kv = new KVStore(this.adapters.kv);
            session = (await kv.getSession(sessionId)) || undefined;
          }
        }

        this.wss.handleUpgrade(message, socket, head, (ws: WebSocket) => {
          this.adapters!.ws.acceptWebSocket(connectionKey, ws, role, session, instanceTag, clusterId);
        });
      } else {
        socket.destroy();
      }
    });
  }
}
