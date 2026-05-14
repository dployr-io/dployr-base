// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { PostgresAdapter } from "@/lib/db/pg-adapter.js";

export interface ServiceMetricsBucket {
  serviceName: string;
  bucket: number;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export class ServiceMetricsStore {
  constructor(private db: PostgresAdapter) {}

  async addMetrics(rows: { serviceName: string; bucket: number; requests: number; bytesIn: number; bytesOut: number }[]): Promise<void> {
    if (rows.length === 0) return;
    // Build multi-row VALUES for a single upsert
    const placeholders = rows.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(", ");
    const params = rows.flatMap((r) => [r.serviceName, r.bucket, r.requests, r.bytesIn, r.bytesOut]);
    await this.db
      .prepare(
        `INSERT INTO service_metrics (service_name, bucket, requests, bytes_in, bytes_out)
         VALUES ${placeholders}
         ON CONFLICT (service_name, bucket) DO UPDATE SET
           requests  = service_metrics.requests  + EXCLUDED.requests,
           bytes_in  = service_metrics.bytes_in  + EXCLUDED.bytes_in,
           bytes_out = service_metrics.bytes_out + EXCLUDED.bytes_out`,
      )
      .bind(...params)
      .run();
  }

  async list(serviceName: string, from: number, to: number): Promise<ServiceMetricsBucket[]> {
    const { results } = await this.db
      .prepare(
        `SELECT service_name, bucket, requests, bytes_in, bytes_out
         FROM service_metrics
         WHERE service_name = $1 AND bucket >= $2 AND bucket <= $3
         ORDER BY bucket ASC`,
      )
      .bind(serviceName, from, to)
      .all<Record<string, unknown>>();

    return results.map((r) => ({
      serviceName: r.service_name as string,
      bucket: Number(r.bucket),
      requests: Number(r.requests),
      bytesIn: Number(r.bytes_in),
      bytesOut: Number(r.bytes_out),
    }));
  }

  async totals(serviceName: string, from: number, to: number): Promise<{ requests: number; bytesIn: number; bytesOut: number }> {
    const r = await this.db
      .prepare(
        `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(bytes_in),0) AS bytes_in, COALESCE(SUM(bytes_out),0) AS bytes_out
         FROM service_metrics
         WHERE service_name = $1 AND bucket >= $2 AND bucket <= $3`,
      )
      .bind(serviceName, from, to)
      .first<Record<string, unknown>>();

    return {
      requests: Number(r?.requests ?? 0),
      bytesIn: Number(r?.bytes_in ?? 0),
      bytesOut: Number(r?.bytes_out ?? 0),
    };
  }

  async prune(olderThanBucket: number): Promise<void> {
    await this.db.prepare(`DELETE FROM service_metrics WHERE bucket < $1`).bind(olderThanBucket).run();
  }
}
