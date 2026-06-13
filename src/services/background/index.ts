// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "events";
import { ulid } from "ulid";
import { initializeAdapters, type Adapters } from "@/lib/config/bootstrap.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { JWTService } from "@/services/auth/jwt.js";
import { InstancePool } from "@/services/pool.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("worker");

export interface JobContext {
  db: DatabaseStore;
  kv: KVStore;
  jwt: JWTService;
  pool: InstancePool;
  adapters: Adapters;
  /** Immediately fire a registered event-driven job by name. */
  trigger: (event: string) => void;
  /** Attach structured output to this job run (merged into the KV record). */
  setOutput: (output: Record<string, unknown>) => void;
}

export type JobFn = (ctx: JobContext) => Promise<void>;

interface ScheduledEntry {
  name: string;
  intervalMs: number;
  fn: JobFn;
  runImmediately: boolean;
  timer?: ReturnType<typeof setInterval>;
}

interface TriggeredEntry {
  name: string;
  fn: JobFn;
  runImmediately: boolean;
}

export class BackgroundWorker {
  private emitter = new EventEmitter();
  private scheduled: ScheduledEntry[] = [];
  private triggered: TriggeredEntry[] = [];
  private adapters: Adapters | null = null;
  private triggerCooldowns = new Map<string, number>();

  schedule(name: string, intervalMs: number, fn: JobFn, options?: { runImmediately?: boolean }): this {
    this.scheduled.push({ name, intervalMs, fn, runImmediately: options?.runImmediately ?? false });
    return this;
  }

  on(event: string, fn: JobFn, options?: { runImmediately?: boolean }): this {
    this.triggered.push({ name: event, fn, runImmediately: options?.runImmediately ?? false });
    this.emitter.on(event, () => this.run(fn, event));
    return this;
  }

  /**
   * Trigger a registered event-driven job from anywhere in the app.
   */
  emit(event: string, cooldownMs = 15_000): void {
    const last = this.triggerCooldowns.get(event) ?? 0;
    if (Date.now() - last < cooldownMs) {
      log.debug(`Skipping duplicate trigger for "${event}" — cooldown active`);
      return;
    }
    this.triggerCooldowns.set(event, Date.now());
    this.emitter.emit(event);
  }

  /**
   * Run a one-off job immediately using the managed job context.
   */
  dispatch(fn: JobFn, name = "dispatch"): void {
    this.run(fn, name);
  }

  async start(): Promise<void> {
    this.adapters = await initializeAdapters();

    for (const entry of this.scheduled) {
      if (entry.runImmediately) {
        this.run(entry.fn, entry.name, entry.intervalMs);
      }
      entry.timer = setInterval(() => this.run(entry.fn, entry.name, entry.intervalMs), entry.intervalMs);
      entry.timer.unref();
    }

    process.on("SIGTERM", () => this.stop());
    process.on("SIGINT", () => this.stop());

    log.info(`Started — ${this.scheduled.length} scheduled, ${this.triggered.length} triggered`);

    for (const entry of this.triggered) {
      if (entry.runImmediately) {
        this.run(entry.fn, entry.name);
      }
    }
  }

  stop(): void {
    for (const entry of this.scheduled) {
      if (entry.timer) clearInterval(entry.timer);
    }
    this.emitter.removeAllListeners();
    log.info("Stopped");
  }

  private async run(fn: JobFn, name: string, intervalMs?: number): Promise<void> {
    if (!this.adapters) return;
    const id = ulid();
    const startedAt = Date.now();
    const kv = new KVStore(this.adapters.kv);
    const db = new DatabaseStore(this.adapters.db);
    const jwt = new JWTService(kv);
    const pool = new InstancePool({
      db,
      kv,
      vm: this.adapters.vmProvider ?? undefined,
      jwt,
      sshKey: this.adapters.config.virtual_machines?.ssh_key,
      registry: this.adapters.config.registry,
      loki: { url: this.adapters.config.loki?.api_domain ? `https://${this.adapters.config.loki.api_domain}` : undefined, pushToken: this.adapters.config.loki?.push_token },
    });
    let output: Record<string, unknown> = {};
    // TTL = 3× the interval (in seconds); falls back to 24h for triggered jobs
    const ttl = intervalMs ? Math.ceil((intervalMs / 1000) * 3) : 60 * 60 * 24;

    const ctx: JobContext = {
      db,
      kv,
      jwt,
      pool,
      adapters: this.adapters,
      trigger: (event) => this.emitter.emit(event),
      setOutput: (o) => { output = { ...output, ...o }; },
    };

    try {
      await fn(ctx);
      const completedAt = Date.now();
      await kv.saveJobRun({ id, job: name, status: "completed", startedAt, completedAt, durationMs: completedAt - startedAt, output, ttl });
    } catch (err) {
      const completedAt = Date.now();
      log.error(`"${name}" failed:`, err);
      await kv.saveJobRun({ id, job: name, status: "failed", startedAt, completedAt, durationMs: completedAt - startedAt, error: String(err), output, ttl });
    }
  }
}

export const worker = new BackgroundWorker();
