import { Hono } from "hono";
import { Bindings, Variables } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// List all deployments
deployments.get("/", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const instances = await d1.instances.getByClusters(session.clusters);

  
  return c.json({});
});

export default deployments;
