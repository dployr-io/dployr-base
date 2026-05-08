// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * FakeNode — a minimal WebSocket client that speaks the dployrd protocol.
 *
 * Lifecycle:
 *  1. exchangeToken()  — bootstrap token → node access token via /v1/node/token
 *  2. connect()        — open WS to /v1/node/ws?instanceName=<tag>
 *  3. waitForTask()    — resolves with the first NodeTask received
 *  4. callFinish()     — POST /v1/deployments/finish on behalf of the task
 *  5. disconnect()     — close WS cleanly
 */

import { WebSocket } from "ws";

export interface NodeTask {
  ID: string;
  Type: string;
  Payload: Record<string, any>;
  Status: string;
}

export interface FakeNodeOptions {
  baseUrl: string;
  instanceTag: string;
  bootstrapToken: string;
}

export class FakeNode {
  private ws: WebSocket | null = null;
  private nodeToken: string = "";
  private baseUrl: string;
  private instanceTag: string;
  private bootstrapToken: string;

  constructor(opts: FakeNodeOptions) {
    this.baseUrl = opts.baseUrl;
    this.instanceTag = opts.instanceTag;
    this.bootstrapToken = opts.bootstrapToken;
  }

  /** Exchange bootstrap token for a short-lived node access token. */
  async exchangeToken(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/node/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.bootstrapToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`/v1/node/token failed ${res.status}: ${body}`);
    }

    const body = (await res.json()) as any;
    this.nodeToken = body.data?.token as string;
    if (!this.nodeToken) throw new Error("No token in /v1/node/token response");
  }

  /** Open a WebSocket connection to /v1/node/ws as this instance. */
  async connect(): Promise<void> {
    if (!this.nodeToken) throw new Error("Call exchangeToken() before connect()");

    const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/v1/node/ws?instanceName=${this.instanceTag}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${this.nodeToken}` },
      });

      ws.once("open", () => {
        this.ws = ws;
        resolve();
      });

      ws.once("error", (err) => reject(new Error(`WS connect error: ${err.message}`)));

      // Timeout safety
      setTimeout(() => reject(new Error("WS connect timed out")), 5_000);
    });
  }

  /**
   * Wait for the next task message from base.
   * Resolves with the first NodeTask in the items array.
   */
  waitForTask(timeoutMs = 8_000): Promise<NodeTask> {
    if (!this.ws) throw new Error("Call connect() first");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for task")), timeoutMs);

      const onMessage = (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.kind === "task" && Array.isArray(msg.items) && msg.items.length > 0) {
            clearTimeout(timer);
            this.ws?.off("message", onMessage);
            resolve(msg.items[0] as NodeTask);
          }
        } catch {
          // ignore parse errors, keep waiting
        }
      };

      this.ws!.on("message", onMessage);
    });
  }

  /**
   * Call POST /v1/deployments/finish as the node would after completing a deployment.
   * `token` is taken from the task payload (the short-lived access JWT dispatched with the task).
   */
  async callFinish(opts: { token: string; id: string; logs: string; blueprint?: Record<string, any> }): Promise<Response> {
    return fetch(`${this.baseUrl}/v1/deployments/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: opts.token,
        id: opts.id,
        logs: opts.logs,
        blueprint: opts.blueprint ?? {},
      }),
    });
  }

  /** Send a task_response back to base (useful for non-deploy task tests). */
  sendTaskResponse(taskId: string, requestId: string, success: boolean, data?: Record<string, any>): void {
    if (!this.ws) throw new Error("Not connected");
    this.ws.send(JSON.stringify({ kind: "task_response", taskId, requestId, success, data }));
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

/** Helper: create an instance via API and return { instanceId, tag, bootstrapToken }. */
export async function createTestInstance(
  baseUrl: string,
  session: string,
  clusterId: string,
  suffix: string = Date.now().toString(36),
): Promise<{ instanceId: string; tag: string; bootstrapToken: string }> {
  const octets = () => Math.floor(Math.random() * 200) + 10;
  const tag = `ci-fn-${suffix}`;
  const res = await fetch(`${baseUrl}/v1/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: session },
    body: JSON.stringify({
      clusterId,
      address: `10.${octets()}.${octets()}.${octets()}`,
      tag,
    }),
  });

  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`Failed to create test instance: ${res.status} ${body}`);
  }

  const body = (await res.json()) as any;
  return {
    instanceId: body.data.instance.id as string,
    tag,
    bootstrapToken: body.data.token as string,
  };
}

/** Helper: delete an instance via API (best-effort, swallows errors). */
export async function deleteTestInstance(baseUrl: string, session: string, instanceId: string): Promise<void> {
  await fetch(`${baseUrl}/v1/instances/${instanceId}`, {
    method: "DELETE",
    headers: { Cookie: session },
  }).catch(() => {});
}
