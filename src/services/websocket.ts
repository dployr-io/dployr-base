// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Buffer } from 'buffer';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { Hono } from 'hono';
import { initializeAdapters, type Adapters } from '@/lib/bootstrap.js';
import { DatabaseStore } from '@/lib/db/store/index.js';
import { loadConfig } from '@/lib/config/loader.js';

export class WebSocketService {
  private server: Server;
  private wss: WebSocketServer;
  private adapters: Adapters | null = null;
  private config = loadConfig();

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
    this.server.listen(this.config.server.port, this.config.server.host, () => {
      console.log(`Dployr Base running on http://${this.config.server.host}:${this.config.server.port}`);
    });
  }

  private createHttpServer(): Server {
    return createServer(async (req, res) => {
      const upgradeHeader = req.headers['upgrade'];
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        console.log('WebSocket upgrade request detected, deferring to upgrade handler');
        return;
      }

      // Collect request body for non-GET/HEAD requests
      let body: Uint8Array | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
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
        })
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

  private setupUpgradeHandler(): void {
    this.server.on('upgrade', async (message: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(message.url || '', `http://${message.headers.host}`);
      
      // Handle cluster WebSocket streams
      // Matches: /v1/instances/stream OR /v1/agent/instances/:instanceId/ws
      if (url.pathname.match(/\/v1\/(instances\/stream|agent\/instances\/[^/]+\/ws)$/)) {
        const role = url.pathname.includes('/ws') ? 'agent' : 'client';
        
        let clusterId: string | null = null;
        
        if (role === 'agent') {
          const match = url.pathname.match(/\/v1\/agent\/instances\/([^/]+)\/ws$/);
          const instanceId = match?.[1];
          
          if (!instanceId || !this.adapters?.db) {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
          }
          
          const db = new DatabaseStore(this.adapters.db);
          const instance = await db.instances.get(instanceId);
          
          if (!instance) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
          }
          
          clusterId = instance.clusterId;
        } else {
          clusterId = url.searchParams.get('clusterId');
        }
        
        if (!clusterId || !this.adapters?.ws) {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        // Validate auth token for agent endpoint
        if (role === 'agent') {
          const authHeader = message.headers['authorization'] || message.headers['Authorization'];
          const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
          if (!auth || !auth.startsWith('Bearer ')) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        this.wss.handleUpgrade(message, socket, head, (ws: WebSocket) => {
          this.adapters!.ws.acceptWebSocket(clusterId, ws, role);
        });
      } else {
        socket.destroy();
      }
    });
  }
}