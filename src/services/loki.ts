// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@/lib/logger.js";
import type { Config } from "@/lib/config/loader.js";

export type LogSource = "runtime" | "build" | "deploy";

export interface LokiLabels {
  serviceId?: string;
  container?: string;
  host?: string;
  source?: LogSource | "dployrd";
  deploymentId?: string;
  clusterId?: string;
}

export interface LokiEntry {
  /** Nanosecond unix timestamp as string — Loki's required format */
  timestampNs: string;
  line: string;
}

export interface LokiQueryResult {
  entries: Array<{ timestampNs: string; line: string; streamLabels?: Record<string, string> }>;
  hasMore: boolean;
  /** Nanosecond timestamp of the last entry; use as cursor for the next page request */
  nextCursor: string;
}

interface BufferedEntry extends LokiEntry {
  labels: LokiLabels;
}

interface PathBuffer {
  entries: BufferedEntry[];
  byteSize: number;
  backoffMs: number;
  nextRetryAt: number;
}

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

interface LokiQueryResponse {
  data?: {
    result?: Array<{ stream: Record<string, string>; values: [string, string][] }>;
  };
}

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DRAIN_INTERVAL_MS = 1_500;
const MAX_BACKOFF_MS = 30_000;
// Loki rejects entries older than its reject_old_samples_max_age (typically 1h or 2h).
// Drop anything older than this before pushing so we never accumulate perpetually-failing entries.
const MAX_ENTRY_AGE_MS = 45 * 60 * 1000; // 45 minutes

/** Convert ISO timestamp string to nanosecond unix timestamp string for Loki */
export function toNanoseconds(isoTime: string): string {
  return (new Date(isoTime).getTime() * 1_000_000).toString();
}

/** Convert nanosecond string back to millisecond unix timestamp */
export function fromNanoseconds(ns: string): number {
  return Math.floor(parseInt(ns) / 1_000_000);
}

export class LokiClient {
  private buffers = new Map<string, PathBuffer>();
  private drainTimer: NodeJS.Timeout | null = null;
  private enabled: boolean;
  private baseUrl: string;
  private log = new Logger("loki");

  constructor(config: Config["loki"]) {
    this.enabled = config?.enabled ?? false;
    this.baseUrl = (config?.url ?? "http://localhost:3100").replace(/\/$/, "");

    if (this.enabled) {
      this.startDrainLoop();
      this.log.info(`Loki client initialised → ${this.baseUrl}`);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Buffer log entries for a path. Called synchronously from handleLogChunk — must not block.
   * path is the logical stream key (e.g. "service:my-app", "deploy-abc123")
   */
  push(path: string, labels: LokiLabels, entries: LokiEntry[]): void {
    if (!this.enabled || entries.length === 0) return;

    let buf = this.buffers.get(path);
    if (!buf) {
      buf = { entries: [], byteSize: 0, backoffMs: 0, nextRetryAt: 0 };
      this.buffers.set(path, buf);
    }

    for (const entry of entries) {
      const entryBytes = entry.line.length + 64;

      // Evict oldest if at capacity before adding
      while ((buf.entries.length >= MAX_ENTRIES || buf.byteSize + entryBytes > MAX_BYTES) && buf.entries.length > 0) {
        const evicted = buf.entries.shift()!;
        buf.byteSize -= evicted.line.length + 64;
      }

      buf.entries.push({ ...entry, labels });
      buf.byteSize += entryBytes;
    }
  }

  /**
   * Query log entries for a service. Returns entries in forward order.
   * startNs / endNs are nanosecond unix timestamps as strings.
   * Pass "0" for startNs to query from the beginning.
   */
  async query(
    labels: Partial<LokiLabels>,
    startNs: string,
    endNs: string,
    limit = 1000,
    direction: "forward" | "backward" = "forward",
  ): Promise<LokiQueryResult> {
    if (!this.enabled) return { entries: [], hasMore: false, nextCursor: "0" };

    const selector = Object.entries(labels)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => {
        // Use regex matcher for pipe-separated multi-value patterns (e.g. "build|deploy")
        if (typeof v === "string" && v.includes("|")) return `${k}=~"${v}"`;
        return `${k}="${v}"`;
      })
      .join(", ");

    // Fetch one extra entry to detect hasMore without a second query.
    // Cap at 5000 to stay within Loki's hard per-query limit.
    const fetchLimit = Math.min(limit + 1, 5000);

    const params = new URLSearchParams({
      query: `{${selector}}`,
      start: startNs,
      end: endNs,
      limit: fetchLimit.toString(),
      direction,
    });

    const res = await fetch(`${this.baseUrl}/loki/api/v1/query_range?${params}`);
    if (!res.ok) {
      throw new Error(`Loki query failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as LokiQueryResponse;
    const streams = json.data?.result ?? [];

    const all = streams
      .flatMap((s) => s.values.map(([ts, line]) => ({ timestampNs: ts, line, streamLabels: s.stream })))
      .sort((a, b) => a.timestampNs.localeCompare(b.timestampNs));

    const hasMore = all.length > limit;
    const entries = hasMore ? all.slice(0, limit) : all;

    // Add 1ns so the next page's inclusive start doesn't re-fetch the last entry.
    const lastNs = entries.length > 0 ? entries[entries.length - 1].timestampNs : startNs;
    const nextCursor = (BigInt(lastNs) + 1n).toString();

    return { entries, hasMore, nextCursor };
  }

  shutdown(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private startDrainLoop(): void {
    this.drainTimer = setInterval(() => {
      this.drain().catch((err) => this.log.error("Drain loop error", { error: String(err) }));
    }, DRAIN_INTERVAL_MS);
    // Don't block process exit
    this.drainTimer.unref();
  }

  private async drain(): Promise<void> {
    const now = Date.now();

    for (const [path, buf] of this.buffers.entries()) {
      if (buf.entries.length === 0) continue;
      if (buf.nextRetryAt > now) continue;

      // Drop entries that are too old for Loki to accept before even trying to push.
      const cutoffNs = ((now - MAX_ENTRY_AGE_MS) * 1_000_000).toString();
      const stale = buf.entries.filter(e => e.timestampNs < cutoffNs).length;
      if (stale > 0) {
        buf.entries = buf.entries.filter(e => e.timestampNs >= cutoffNs);
        buf.byteSize = buf.entries.reduce((s, e) => s + e.line.length + 64, 0);
        this.log.debug(`Dropped ${stale} stale Loki entries for "${path}" (older than ${MAX_ENTRY_AGE_MS / 60000}m)`);
      }
      if (buf.entries.length === 0) continue;

      // Snapshot the current batch and clear the buffer
      const batch = buf.entries.splice(0);
      buf.byteSize = 0;

      try {
        await this.pushToLoki(batch);
        buf.backoffMs = 0;
      } catch (err) {
        const errMsg = String(err);
        // Loki 400 "entry too far behind" — these will never succeed; discard rather than retry.
        if (errMsg.includes("entry too far behind")) {
          this.log.warn(`Loki rejected ${batch.length} stale entries for "${path}" — discarding`, { error: errMsg });
          buf.backoffMs = 0;
          continue;
        }

        // Restore entries at the front (preserve order)
        buf.entries.unshift(...batch);
        buf.byteSize = batch.reduce((s, e) => s + e.line.length + 64, 0);

        buf.backoffMs = buf.backoffMs === 0 ? 2_000 : Math.min(buf.backoffMs * 2, MAX_BACKOFF_MS);
        buf.nextRetryAt = now + buf.backoffMs;

        this.log.warn(`Loki push failed for "${path}", retry in ${buf.backoffMs}ms`, { error: errMsg });

        // Trim to limits while backing off
        while ((buf.entries.length > MAX_ENTRIES || buf.byteSize > MAX_BYTES) && buf.entries.length > 0) {
          const evicted = buf.entries.shift()!;
          buf.byteSize -= evicted.line.length + 64;
        }
      }
    }
  }

  private async pushToLoki(entries: BufferedEntry[]): Promise<void> {
    // Group entries into Loki streams by label fingerprint
    const streamMap = new Map<string, LokiStream>();

    for (const entry of entries) {
      const labelRecord = this.labelsToRecord(entry.labels);
      const key = JSON.stringify(labelRecord);

      let stream = streamMap.get(key);
      if (!stream) {
        stream = { stream: labelRecord, values: [] };
        streamMap.set(key, stream);
      }
      stream.values.push([entry.timestampNs, entry.line]);
    }

    const body = { streams: Array.from(streamMap.values()) };

    const res = await fetch(`${this.baseUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
  }

  private labelsToRecord(labels: LokiLabels): Record<string, string> {
    const record: Record<string, string> = {};
    if (labels.serviceId) { record.serviceId = labels.serviceId; record.service_name = labels.serviceId; }
    if (labels.container) record.container = labels.container;
    if (labels.host) record.host = labels.host;
    if (labels.source) record.source = labels.source;
    if (labels.deploymentId) record.deploymentId = labels.deploymentId;
    if (labels.clusterId) record.clusterId = labels.clusterId;
    return record;
  }
}
