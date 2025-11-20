// middleware/auth.ts
import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings, Variables } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { ERROR } from "@/lib/constants";

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

export async function requireClusterViewer(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = c.get("session");

  if (!session) {
    return c.json({ 
      error: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }, ERROR.AUTH.BAD_SESSION.status);
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const param = c.req.param("id");
  const query = c.req.query("clusterId");
  const clusterId = data.clusterId || param || query;

  if (!clusterId) {
    return c.json({ error: "clusterId is required" }, 400);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const canRead = await d1.clusters.canRead(session.userId, clusterId);

  if (!canRead) {
    return c.json({ 
      error: "Insufficient permissions. Viewer role is required to perform this action", 
      code: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.status);
  }

  await next();
}

export async function requireClusterDeveloper(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = c.get("session");

  if (!session) {
    return c.json({ 
      error: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }, ERROR.AUTH.BAD_SESSION.status);
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const param = c.req.param("id");
  const query = c.req.query("clusterId");
  const clusterId = data.clusterId || param || query;

  if (!clusterId) {
    return c.json({ error: "clusterId is required" }, 400);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const canWrite = await d1.clusters.canWrite(session.userId, clusterId);

  if (!canWrite) {
    return c.json({ 
      error: "Insufficient permissions. Developer role is requried to perform this action", 
      code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.status);
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

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const param = c.req.param("id");
  const query = c.req.query("clusterId");
  const clusterId = data.clusterId || param || query;

  if (!clusterId) {
    return c.json({ error: "clusterId is required" }, 400);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const isAdmin = await d1.clusters.isAdmin(session.userId, clusterId);

  if (!isAdmin) {
    return c.json({ 
      error: "Insufficient permissions. Admin role is requried to perform this action", 
      code: ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.status);
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

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const param = c.req.param("id");
  const query = c.req.query("clusterId");
  const clusterId = data.clusterId || param || query;

  if (!clusterId) {
    return c.json({ error: "clusterId is required" }, 400);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const isOwner = await d1.clusters.isOwner(session.userId, clusterId);

  if (!isOwner) {
    return c.json({ 
      error: "Insufficient permissions. Owner role is requried to perform this action", 
      code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status);
  }

  await next();
}
