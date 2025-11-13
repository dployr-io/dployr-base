import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import z, { codec } from "zod";
import { authMiddleware } from "@/middleware/auth";
import { BAD_REQUEST, BAD_SESSION, INTERNAL_SERVER_ERROR } from "@/lib/constants";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();
instances.use("*", authMiddleware);

const createInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().min(10, "Address is required"),
  publicKey: z.string().min(50, "Public key is too short").max(500, "Public key is too long"),
  tag: z.string().min(3).max(16, "Choose a valid tag"),
  metadata: z.record(z.string(), z.any()).optional(),
});

// List all instances
instances.get("/", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json(createErrorResponse({ message: "Not authenticated", code: BAD_SESSION }), 401);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json(createErrorResponse({ message: "Invalid or expired session", code: BAD_SESSION }), 401);
  }

  const { page, pageSize, offset } = parsePaginationParams(
    c.req.query("page"),
    c.req.query("pageSize")
  );

  const { instances, total } = await d1.instances.getByClusters(
    session.clusters,
    pageSize,
    offset
  );

  const paginatedData = createPaginatedResponse(instances, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

// Create a new instance
instances.post("/", async (c) => {
  try {
    const sessionId = getCookie(c, "session");

    if (!sessionId) {
      return c.json(createErrorResponse({ message: "Not authenticated", code: BAD_SESSION }), 401);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);
    const session = await kv.getSession(sessionId);

    if (!session) {
      return c.json(createErrorResponse({ message: "Invalid or expired session", code: BAD_SESSION }), 401);
    }

    const data = await c.req.json();

    const validation = createInstanceSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ message: "Validation failed " + errors, code: BAD_REQUEST }), 400);
    }

    const { clusterId, address, publicKey, tag, metadata } = validation.data;

    const instance = await d1.instances.create(clusterId, publicKey, {
      address,
      publicKey,
      tag,
      metadata: metadata || {},
    });

    // Connect to your Dployr instance
    // const { client, tokenManager } = createDployrClient(address);

    // // Login to get authentication tokens
    // const auth = await client.auth.request.post({
    //   email: session.email,
    //   secret: 
    // });

    // // Store tokens for authenticated requests
    // tokenManager.setTokens(auth?.accessToken || '', auth?.refreshToken || '');

    // // Now you can make authenticated API calls
    // const deployments = await client.deployments.get();
    // const services = await client.services.get();

    return c.json(createSuccessResponse({ instance }, "Instance created successfully"));
  } catch (error) {
    console.error("Failed to create instance", error);
     const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ message: "Instance creation failed", code: INTERNAL_SERVER_ERROR, helpLink }), 500);
  }
});

export default instances;
