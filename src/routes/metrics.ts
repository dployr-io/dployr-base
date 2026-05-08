// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Bindings, Variables } from "@/types/index.js";
import { getDbStore, getWS } from "@/lib/config/context.js";

const metrics = new Hono<{ Bindings: Bindings; Variables: Variables }>();

metrics.get("/", async (c) => {
  const token = c.env.METRICS_SCRAPE_TOKEN;
  if (token) {
    const auth = c.req.header("Authorization") ?? "";
    if (auth !== `Bearer ${token}`) {
      return c.text("Unauthorized", 401);
    }
  }

  const db = getDbStore(c);
  const [{ deployments: pending }, { deployments: recent }, { instances }, { total: totalServices }, totalClusters, paidIndieCount, paidProCount] = await Promise.all([
    db.deployments.list({ status: "pending" }),
    db.deployments.list({ limit: 200 }),
    db.instances.list(),
    db.services.list(),
    db.clusters.count(),
    db.billing.count({ plan: "indie", status: "active" }),
    db.billing.count({ plan: "pro", status: "active" }),
  ]);

  const paidClusters = paidIndieCount + paidProCount;
  const planCounts = { indie: paidIndieCount, pro: paidProCount };
  const byStatus: Record<string, number> = {};
  for (const inst of instances) {
    const s = inst.status ?? "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }

  let ws = { totalConnections: 0, nodeConnections: 0, clientConnections: 0, pendingRequests: 0 };
  try { Object.assign(ws, getWS(c).connectionManager.getStats()); } catch { /* not initialized */ }

  const lines: string[] = [];
  const g = (name: string, help: string, value: number, labels = "") => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels ? `{${labels}}` : ""} ${value}`);
  };

  g("dployr_clusters_total", "Total clusters", totalClusters);
  g("dployr_clusters_paid", "Paid clusters", paidClusters);
  g("dployr_clusters_free", "Free clusters (hobby)", totalClusters - paidClusters);
  for (const [plan, n] of Object.entries(planCounts)) g("dployr_clusters_by_plan", "Clusters by plan", n, `plan="${plan}"`);

  g("dployr_instances_total", "Total instances", instances.length);
  for (const [status, n] of Object.entries(byStatus)) g("dployr_instances_by_status", "Instances by status", n, `status="${status}"`);

  g("dployr_services_total", "Total services", totalServices);

  g("dployr_deployments_pending", "Pending deployments", pending.length);
  g("dployr_deployments_stale", "Pending deployments older than 5 minutes", pending.filter((d) => (d.createdAt as unknown as number) < Date.now() - 300_000).length);
  g("dployr_deployments_success_recent", "Succeeded deployments (recent 200)", recent.filter((d) => d.status === "success").length);
  g("dployr_deployments_failed_recent", "Failed deployments (recent 200)", recent.filter((d) => d.status === "failed").length);

  g("dployr_ws_connections_total", "Total active WebSocket connections", ws.totalConnections);
  g("dployr_ws_node_connections", "Node WebSocket connections", ws.nodeConnections);
  g("dployr_ws_client_connections", "Client WebSocket connections", ws.clientConnections);
  g("dployr_ws_pending_requests", "Pending WebSocket requests", ws.pendingRequests);

  return c.text(lines.join("\n") + "\n", 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
});

export default metrics;
