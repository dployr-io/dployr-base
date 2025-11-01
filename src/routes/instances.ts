// routes/auth.ts
import { Hono } from "hono";
import { Bindings, Variables, OAuthProvider } from "@/types";
import { OAuthService } from "@/services/oauth";
import { KVStore } from "@/lib/db/store/kv";
import { setCookie, getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import z from "zod";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const createInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().min(10, "Address is required"),
  tag: z.string().min(3).max(16, "Choose a valid tag"),
  metadata: z.record(z.string(), z.any()).optional(),
});


// List all instances
instances.get("/", async (c) => {
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

  return c.json({ instances });
});

// Create a new instance
instances.post("/", async (c) => {
  try {
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

    const data = await c.req.json();

    const validation = createInstanceSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map(err => ({
        field: err.path.join('.'),
        message: err.message
      }));
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const { clusterId, address, tag, metadata } = validation.data;

    const instance = await d1.instances.create(clusterId, {
      address,
      tag,
      metadata: metadata || {},
    });

    return c.json({
      instance,
    });
  } catch (error) {
    const message = "Failed to create instance";
    console.error(message, error);
    return c.json({ error: message }, 500);
  }
});

export default instances;
