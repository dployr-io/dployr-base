// routes/admin/admin.ts
import { Hono } from "hono";
import * as OTPAuth from "otpauth";
import { readFileSync } from "fs";
import { join } from "path";
import { Bindings, createErrorResponse, createSuccessResponse, Variables } from "@/types/index.js";
import { getKVStore, getDbStore, getWS } from "@/lib/config/context.js";
import { requireDployrAdministrator, requireDployrAdministratorIPAddress } from "@/middleware/auth.js";
import instances from "./instances/index.js";
import { ADMIN_JWT_TTL, ERROR } from "@/lib/constants/index.js";
import { getVMService } from "@/lib/config/context.js";
import { Logger } from "@/lib/logger.js";
import { AdminService } from "@/services/admin.js";

const log = new Logger("admin");
const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply IP whitelist and admin middleware
admin.use("*", requireDployrAdministratorIPAddress);

// Config endpoint - provides runtime configuration to dployr admin
admin.get("/config.js", (c) => {
  return c.text(
    `window.__CONFIG__ = ${JSON.stringify({
      API_BASE: c.env.BASE_URL,
    })};`,
    200,
    {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store",
    },
  );
});

// Serve static admin page
admin.get("/", async (c) => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf-8");
  return c.html(html);
});

admin.post("/login", async (c) => {
  const { api_key, otp_code, session_id } = await c.req.json().catch(() => ({}));

  const errorRes = c.json(
    createErrorResponse({
      message: "Invalid credentials",
      code: ERROR.AUTH.BAD_TOKEN.code,
    }),
    ERROR.AUTH.BAD_TOKEN.status,
  );

  if (!c.env.ADMIN_TOTP_SECRET) {
    return c.json(
      createErrorResponse({
        message: "TOTP secret not configured",
        code: ERROR.RUNTIME.ADMIN_TOTP_NOT_CONFIGURED.code,
      }),
      ERROR.RUNTIME.ADMIN_TOTP_NOT_CONFIGURED.status,
    );
  }

  if (api_key !== c.env.ADMIN_API_KEY || !otp_code || !/^\d{6}$/.test(otp_code)) {
    return errorRes;
  }

  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(c.env.ADMIN_TOTP_SECRET),
  });

  // validate OTP (±30s window)
  if (totp.validate({ token: otp_code, window: 1 }) === null) {
    return errorRes;
  }

  const sessionId = session_id ?? `adm_${crypto.randomUUID().slice(0, 8)}`;
  // 7 days in dev mode, 30 minutes in prod (set in ADMIN_JWT_TTL)
  const ttl =
    process.env.NODE_ENV === "development"
      ? 604800 // 7 days in s
      : ADMIN_JWT_TTL; // e.g., "30m"

  const kv = getKVStore(c);
  const token = await kv.createAdminJWT({ sessionId, ttl });

  await kv.saveAdminJWT({ sessionId, token, ttl });

  return c.json(createSuccessResponse({ token, expiresIn: ttl, sessionId }));
});

admin.use("*", requireDployrAdministrator);

admin.get("/events", async (c) => {
  const kv = getKVStore(c);
  const events = await kv.getAllEvents();
  return c.json(createSuccessResponse({ events }));
});

admin.get("/deployments", async (c) => {
  const db = getDbStore(c);
  const { deployments, total } = await db.deployments.list({});

  // Resolve cluster names in one batch so the UI doesn't show raw IDs.
  const clusterIds = [...new Set(deployments.map((d) => d.clusterId).filter(Boolean))];
  const clusters = await Promise.all(clusterIds.map((id) => db.clusters.get(id)));
  const clusterNameById = new Map(clusters.filter(Boolean).map((cl) => [cl!.id, cl!.name]));

  const enriched = deployments.map((d) => ({
    ...d,
    clusterName: clusterNameById.get(d.clusterId) ?? null,
  }));

  return c.json(createSuccessResponse({ deployments: enriched, total }));
});

admin.get("/services", async (c) => {
  const db = getDbStore(c);
  const { services, total } = await db.services.list();

  // Resolve cluster and deployment names in one batch.
  const clusterIds = [...new Set(services.map((s) => s.clusterId).filter(Boolean))];
  const deploymentIds = [...new Set(services.map((s) => s.deploymentId).filter(Boolean))];

  const [clusters, deployments] = await Promise.all([
    Promise.all(clusterIds.map((id) => db.clusters.get(id))),
    Promise.all(deploymentIds.map((id) => db.deployments.get(id as string))),
  ]);

  const clusterNameById = new Map(clusters.filter(Boolean).map((cl) => [cl!.id, cl!.name]));
  const deploymentNameById = new Map(deployments.filter(Boolean).map((d) => [d!.id, d!.name]));

  const enriched = services.map((s) => ({
    ...s,
    clusterName: clusterNameById.get(s.clusterId) ?? null,
    deploymentName: s.deploymentId ? (deploymentNameById.get(s.deploymentId) ?? null) : null,
  }));

  return c.json(createSuccessResponse({ services: enriched, total }));
});

admin.get("/topology", async (c) => {
  const db = getDbStore(c);
  const kv = getKVStore(c);
  const ws = getWS(c);

  const adminService = new AdminService(db, kv, ws.connectionManager);
  const nodes = await adminService.getTopology();

  return c.json(createSuccessResponse({ nodes }));
});

admin.get("/jobs", async (c) => {
  const kv = getKVStore(c);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const runs = await kv.getRecentJobRuns(limit);
  return c.json(createSuccessResponse({ runs }));
});

admin.get("/instances/:tag/processes", async (c) => {
  const tag = c.req.param("tag");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "60", 10), 300);
  const kv = getKVStore(c);
  const snapshots = await kv.instanceCache.getLatestProcessSnapshots({ tag, limit });
  return c.json(createSuccessResponse({ tag, snapshots }));
});

admin.get("/metrics", async (c) => {
  const db = getDbStore(c);

  const [
    { deployments: pending },
    { deployments: allDeployments },
    { total: totalServices },
    { instances: allInstances },
    totalClusters,
    paidIndieCount,
    paidProCount,
  ] = await Promise.all([
    db.deployments.list({ status: "pending" }),
    db.deployments.list({ limit: 200 }),
    db.services.list(),
    db.instances.list(),
    db.clusters.count(),
    db.billing.count({ plan: "indie", status: "active" }),
    db.billing.count({ plan: "pro", status: "active" }),
  ]);

  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const stalePending = pending.filter((d) => (d.createdAt as unknown as number) < fiveMinutesAgo).length;

  const recentFailed = allDeployments.filter((d) => d.status === "failed").length;
  const recentSuccess = allDeployments.filter((d) => d.status === "success").length;

  const planCounts = { indie: paidIndieCount, pro: paidProCount };
  const paidClusters = paidIndieCount + paidProCount;

  const instancesByStatus: Record<string, number> = {};
  for (const inst of allInstances) {
    const s = inst.status ?? "unknown";
    instancesByStatus[s] = (instancesByStatus[s] ?? 0) + 1;
  }

  let wsStats: ReturnType<ReturnType<typeof getWS>["connectionManager"]["getStats"]> | null = null;
  try {
    wsStats = getWS(c).connectionManager.getStats();
  } catch {
    // wsHandler not initialized in this request context
  }

  return c.json(
    createSuccessResponse({
      ws: wsStats
        ? {
            totalConnections: wsStats.totalConnections,
            nodeConnections: wsStats.nodeConnections,
            clientConnections: wsStats.clientConnections,
            pendingRequests: wsStats.pendingRequests,
          }
        : null,
      clusters: {
        total: totalClusters,
        paid: paidClusters,
        free: totalClusters - paidClusters,
        byPlan: planCounts,
      },
      instances: {
        total: allInstances.length,
        byStatus: instancesByStatus,
        healthy: instancesByStatus["healthy"] ?? 0,
        degraded: instancesByStatus["degraded"] ?? 0,
        offline: (instancesByStatus["offline"] ?? 0) + (instancesByStatus["unreachable"] ?? 0),
      },
      deployments: {
        pending: pending.length,
        stalePendingOver5m: stalePending,
        recentFailed,
        recentSuccess,
      },
      services: { total: totalServices },
    }),
  );
});

/**
 * Admin endpoint: delete instance AND VM droplet.
 * Protected by requireDployrAdministrator middleware.
 * Accepts instance ID or tag name.
 */
admin.delete("/remove-instance/:id", async (c) => {
  const identifier = c.req.param("id");
  const db = getDbStore(c);
  const vm = getVMService(c);

  try {
    let instance = await db.instances.find({ id: identifier });
    if (!instance) {
      instance = await db.instances.find({ tag: identifier });
    }

    if (!instance) {
      return c.json(
        createErrorResponse({
          message: "Instance not found",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    try {
      await vm.delete(instance.tag);
    } catch (err: any) {
      log.error(`Failed to delete VM: ${err.message}`);
      throw err;
    }

    await db.instances.delete({ id: instance.id });

    return c.json(createSuccessResponse({ deleted: true, instance: instance.tag }));
  } catch (err: any) {
    return c.json(
      createErrorResponse({
        message: "Failed to delete instance",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }
});

admin.route("/instances", instances);

export default admin;
