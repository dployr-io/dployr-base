import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types";
import { authMiddleware } from "@/middleware/auth";
import { KVStore } from "@/lib/db/store/kv";
import { getCookie } from "hono/cookie";
import { ERROR } from "@/lib/constants";

const runtime = new Hono<{ Bindings: Bindings; Variables: Variables }>();
runtime.use("*", authMiddleware);

runtime.get("/events", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json(createErrorResponse({
      message: "Not authenticated",
      code: ERROR.AUTH.BAD_SESSION.code,
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json(createErrorResponse({
      message: "Invalid or expired session",
      code: ERROR.AUTH.BAD_SESSION.code,
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  try {
    const events = await kv.getEvents(session.userId);
    return c.json(createSuccessResponse({ events }));
  } catch (error) {
    console.error("Failed to retrieve events", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({
      message: "Failed to retrieve events",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default runtime;
