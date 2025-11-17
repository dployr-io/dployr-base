// middleware/auth.ts
import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings, Variables } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { ADMIN_ROLE_REQUIRED } from "@/lib/constants";

export async function authMiddleware(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  c.set("session", session);
  await next();
}

export async function requireClusterDeveloper(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = c.get("session");

  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const data = await c.req.json();
  const param = c.req.param("id");
  const clusterId = data.clusterId || param;

  if (!clusterId) {
    return c.json({ error: "clusterId is required" }, 400);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const canWrite = await d1.clusters.canWrite(session.userId, clusterId);

  if (!canWrite) {
    return c.json({ error: "Insufficient permissions. Developer role is requried to perform this action", code: ADMIN_ROLE_REQUIRED }, 403);
  }

  await next();
}

export async function requireClusterAdmin(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = c.get("session");

  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const data = await c.req.json();
  const param = c.req.param("id");
  const clusterId = data.clusterId || param;

  if (!clusterId) {
    return c.json({ error: "clusterId is required" }, 400);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const isAdmin = await d1.clusters.isAdmin(session.userId, clusterId);

  if (!isAdmin) {
    return c.json({ error: "Insufficient permissions. Admin role is requried to perform this action", code: ADMIN_ROLE_REQUIRED }, 403);
  }

  await next();
}

export async function requireClusterOwner(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = c.get("session");

  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const data = await c.req.json();
  const clusterId = data.clusterId;

  if (!clusterId) {
    return c.json({ error: "clusterId is required" }, 400);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const isOwner = await d1.clusters.isOwner(session.userId, clusterId);

  if (!isOwner) {
    return c.json({ error: "Insufficient permissions. Owner role is requried to perform this action", code: ADMIN_ROLE_REQUIRED }, 403);
  }

  await next();
}
