// middleware/auth.ts
import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings, Variables } from "@/types";
import { KVStore } from "@/lib/db/store/kv";

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
