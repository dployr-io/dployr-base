// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "events";
import { initializeAdapters, type Adapters } from "@/lib/config/bootstrap.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";

export interface JobContext {
  db: DatabaseStore;
  kv: KVStore;
  adapters: Adapters;
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
  emit(event: string): void {
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
        this.run(entry.fn, entry.name);
      }
      entry.timer = setInterval(() => this.run(entry.fn, entry.name), entry.intervalMs);
      entry.timer.unref();
    }

    process.on("SIGTERM", () => this.stop());
    process.on("SIGINT", () => this.stop());

    console.log(`[Worker] Started — ${this.scheduled.length} scheduled, ${this.triggered.length} triggered`);

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
    console.log("[Worker] Stopped");
  }

  private async run(fn: JobFn, name: string): Promise<void> {
    if (!this.adapters) return;
    const ctx: JobContext = {
      db: new DatabaseStore(this.adapters.db),
      kv: new KVStore(this.adapters.kv),
      adapters: this.adapters,
    };
    try {
      await fn(ctx);
    } catch (err) {
      console.error(`[Worker] "${name}" failed:`, err);
    }
  }
}

export const worker = new BackgroundWorker();
