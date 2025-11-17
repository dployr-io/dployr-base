import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import { authMiddleware } from "@/middleware/auth";
import { ERROR } from "@/lib/constants";

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables }>();
deployments.use("*", authMiddleware);

// List all deployments
deployments.get("/", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json(createErrorResponse({
      message: "Not authenticated",
      code: ERROR.AUTH.BAD_SESSION.code
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json(createErrorResponse({
      message: "Invalid or expired session",
      code: ERROR.AUTH.BAD_SESSION.code
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  const instances = await d1.instances.getByClusters(session.clusters);

  // TODO: Implement deployment listing logic
  return c.json(createSuccessResponse({ deployments: [], instances }));
});

export default deployments;
