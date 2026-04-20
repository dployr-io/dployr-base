// routes/admin/admin.ts
import { Hono } from "hono";
import { Bindings, createErrorResponse, createSuccessResponse, Variables } from "@/types/index.js";
import { requireDployrAdminstrator } from "@/middleware/auth.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { getDB, getKV } from "@/lib/context.js";
import { ERROR, ADMIN_JWT_TTL } from "@/lib/constants/index.js";

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Login endpoint - exchange static API key for JWT (public, no auth required)
admin.post("/login", async (c) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  const validKey = c.env.ADMIN_API_KEY;

  if (!token || token !== validKey) {
    return c.json(createErrorResponse({
      message: "Invalid admin token",
      code: ERROR.AUTH.BAD_TOKEN.code
    }), ERROR.AUTH.BAD_TOKEN.status);
  }

  const sessionId = c.req.header("X-Session-Id");
  if (!sessionId) {
    return c.json(createErrorResponse({
      message: "X-Session-Id missing from header",
      code: ERROR.REQUEST.BAD_REQUEST.code
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const kv = new KVStore(getKV(c));
  const jwt = await kv.createAdminJWT(sessionId, ADMIN_JWT_TTL);
  await kv.saveAdminJWT(sessionId, jwt, ADMIN_JWT_TTL);

  return c.json(createSuccessResponse({ token: jwt, expiresIn: ADMIN_JWT_TTL }));
});

// All other routes require admin auth
admin.use("*", requireDployrAdminstrator);

// List datasources
admin.get("/datasources", async (c) => {
  const res = await adminFetch(c, "/api/datasources");
  return c.json(createSuccessResponse(res));
});

function adminFetch(c: any, path: string, init?: RequestInit) {
  const base = c.env.GRAFANA_URL;

  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

export default admin;
