// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import {
  Bindings,
  Variables,
  createErrorResponse,
  createSuccessResponse,
} from "@/types/index.js";
import type { DNSProvider } from "@/types/dns.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { authMiddleware, requireClusterDeveloper } from "@/middleware/auth.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { getDB, getKV, type AppVariables } from "@/lib/context.js";
import { DNSService } from "@/services/dns.js";
import { InstanceService } from "@/services/instances.js";

const domains = new Hono<{
  Bindings: Bindings;
  Variables: Variables & AppVariables;
}>();

const registerInstanceSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

const setupSchema = z.object({
  domain: z.string()
    .min(3, "Domain must be at least 3 characters")
    .max(253, "Domain must be at most 253 characters")
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "Invalid domain format"),
  instanceId: z.ulid("Invalid instance ID"),
});

// Register instance with bootstrap token
domains.post("/register", async (c) => {
  try {
    const body = await c.req.json();
    const validation = registerInstanceSchema.safeParse(body);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(
        createErrorResponse({
          message: "Validation failed " + JSON.stringify(errors),
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status
      );
    }

    const { token } = validation.data;
    const service = new InstanceService(c.env);
    const result = await service.registerInstance({ token, c });

    if (!result.ok) {
      if (result.reason === "invalid_token") {
        return c.json(
          createErrorResponse({
            message: "Invalid or expired token",
            code: ERROR.AUTH.BAD_TOKEN.code,
          }),
          ERROR.AUTH.BAD_TOKEN.status
        );
      }

      if (result.reason === "invalid_type") {
        return c.json(
          createErrorResponse({
            message: "Invalid token type",
            code: ERROR.AUTH.BAD_TOKEN.code,
          }),
          ERROR.AUTH.BAD_TOKEN.status
        );
      }

      return c.json(
        createErrorResponse({
          message: "Token already used",
          code: ERROR.AUTH.BAD_TOKEN.code,
        }),
        ERROR.AUTH.BAD_TOKEN.status
      );
    }

    const domain = await service.saveDomain({
      instanceName: result.instanceName,
      c,
    });

    // Get instance to include ID in response for agent compatibility
    const db = new DatabaseStore(getDB(c));
    const instance = await db.instances.getByName(result.instanceName);
    if (!instance) {
      throw new Error("Instance not found after domain save");
    }

    const kv = new KVStore(getKV(c));
    await kv.logEvent({
      actor: {
        id: result.instanceName,
        type: "headless",
      },
      targets: [
        {
          id: domain,
        },
      ],
      type: EVENTS.RESOURCE.RESOURCE_CREATED.code,
      request: c.req.raw,
    });

    return c.json(
      createSuccessResponse({
        instanceId: instance.tag,
        domain,
        issuer: c.env.BASE_URL,
        audience: "dployr-instance",
      })
    );
  } catch (error) {
    console.error("Failed to register instance", error);
    return c.json(
      createErrorResponse({
        message: "Instance registration failed",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status
    );
  }
});

// Create custom domain
domains.post("/", authMiddleware, requireClusterDeveloper, async (c) => {
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c));
  const kv = new KVStore(getKV(c));
  const dns = new DNSService(c.env);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      createErrorResponse({ message: "Invalid request body", code: ERROR.REQUEST.BAD_REQUEST.code }),
      400
    );
  }

  const validation = setupSchema.safeParse(body);
  if (!validation.success) {
    const msg = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
    return c.json(createErrorResponse({ message: msg, code: ERROR.REQUEST.BAD_REQUEST.code }), 400);
  }

  const { domain, instanceId } = validation.data;
  const normalizedDomain = domain.toLowerCase();

  // Check instance exists and user has access
  const instance = await db.instances.get(instanceId);
  if (!instance) {
    return c.json(
      createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      404
    );
  }

  const canWrite = await db.clusters.canWrite(session.userId, instance.clusterId);
  if (!canWrite) {
    return c.json(
      createErrorResponse({ message: "Permission denied", code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code }),
      403
    );
  }

  // Check domain not already claimed by another instance
  const existing = await db.domains.get(normalizedDomain);
  if (existing && existing.instanceId !== instanceId) {
    return c.json(
      createErrorResponse({ message: "Domain already registered to another instance", code: ERROR.RESOURCE.CONFLICT.code }),
      409
    );
  }

  const { provider, hasOAuth } = await dns.detectProvider(normalizedDomain);

  // Use existing domain data or create new
  let domainRecord = existing;
  if (!domainRecord) {
    const token = dns.generateToken();
    domainRecord = await db.domains.create(instanceId, normalizedDomain, token, provider);
  }

  // Build records from stored data (never regenerate token)
  // Use instance.address for A record target
  const { record, verification } = dns.buildRecordsFromStored(
    normalizedDomain,
    instance.address,
    domainRecord.verificationToken
  );

  let autoSetupUrl: string | null = null;
  if (hasOAuth) {
    const state = crypto.randomUUID();
    await kv.createState(state, `/settings/domains?domain=${encodeURIComponent(normalizedDomain)}`);
    autoSetupUrl = dns.buildOAuthUrl(provider, state, c.env.BASE_URL);
  }

  return c.json(createSuccessResponse({
    domain: normalizedDomain,
    provider,
    hasOAuth,
    record,
    verification,
    autoSetupUrl,
    manualGuideUrl: dns.getManualGuideUrl(provider),
  }));
});

// Caddy verification endpoint (no auth - called by Caddy)
domains.get("/verify", async (c) => {
  const domain = c.req.query("domain")?.toLowerCase();
  if (!domain) {
    return c.text("missing domain parameter", 400);
  }

  const db = new DatabaseStore(getDB(c));
  const dns = new DNSService(c.env);
  const record = await db.domains.get(domain);

  if (!record) {
    return c.text("domain not registered", 404);
  }

  if (record.status === "active") {
    return c.text("ok", 200);
  }

  const verified = await dns.checkTxtRecord(domain, record.verificationToken);
  if (!verified) {
    return c.text("verification pending", 403);
  }

  await db.domains.activate(domain);
  return c.text("ok", 200);
});

// Client-initiated domain verification check
domains.post("/:domain/verify", authMiddleware, requireClusterDeveloper, async (c) => {
  try {
    const domain = c.req.param("domain").toLowerCase();
    const db = new DatabaseStore(getDB(c));
    const dns = new DNSService(c.env);

    const record = await db.domains.get(domain);
    if (!record) {
      return c.json(
        createErrorResponse({ message: "Domain not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
        404
      );
    }

    const instance = await db.instances.get(record.instanceId);
    if (!instance) {
      return c.json(
        createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
        404
      );
    }

    await dns.checkTxtRecord(domain, record.verificationToken);

    await db.domains.activate(domain);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("Domain verification error:", err);
    return c.json(
      createErrorResponse({
        message: "Domain verification failed",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Get domain details
domains.get("/:domain", authMiddleware, async (c) => {
  const domain = c.req.param("domain").toLowerCase();
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c));
  const dns = new DNSService(c.env);

  const domainRecord = await db.domains.get(domain);
  if (!domainRecord) {
    return c.json(
      createErrorResponse({ message: "Domain not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      404
    );
  }

  const instance = await db.instances.get(domainRecord.instanceId);
  if (!instance) {
    return c.json(
      createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      404
    );
  }

  // Permission check
  const canRead = await db.clusters.canRead(session.userId, instance.clusterId);
  if (!canRead) {
    return c.json(
      createErrorResponse({ message: "Permission denied", code: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.code }),
      403
    );
  }

  const response: any = {
    domain: domainRecord.domain,
    status: domainRecord.status,
    instanceId: domainRecord.instanceId,
    provider: domainRecord.provider,
    createdAt: domainRecord.createdAt,
    activatedAt: domainRecord.activatedAt,
  };

  // For pending domains, include verification records
  // Use instance.address for A record target
  if (domainRecord.status === "pending") {
    const { record, verification } = dns.buildRecordsFromStored(
      domain,
      instance.address,
      domainRecord.verificationToken
    );
    response.record = record;
    response.verification = verification;

    // Add setup URLs if available
    if (domainRecord.provider) {
      const state = crypto.randomUUID();
      const kv = new KVStore(getKV(c));
      await kv.createState(state, `/settings/domains?domain=${encodeURIComponent(domain)}`);
      const oauthUrl = dns.buildOAuthUrl(domainRecord.provider, state, c.env.BASE_URL);
      if (oauthUrl) {
        response.autoSetupUrl = oauthUrl;
      }
    }
    response.manualGuideUrl = dns.getManualGuideUrl(domainRecord.provider || "unknown");
  }

  return c.json(createSuccessResponse(response));
});

// List domains for an instance
domains.get("/instance/:instanceId", authMiddleware, async (c) => {
  const instanceId = c.req.param("instanceId");
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c));

  const instance = await db.instances.get(instanceId);
  if (!instance) {
    return c.json(
      createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      404
    );
  }

  const canRead = await db.clusters.canRead(session.userId, instance.clusterId);
  if (!canRead) {
    return c.json(
      createErrorResponse({ message: "Permission denied", code: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.code }),
      403
    );
  }

  const domainsList = await db.domains.listByInstance(instanceId);
  return c.json(createSuccessResponse({ domains: domainsList }));
});

// Remove domain from instance
domains.delete("/:domain", authMiddleware, requireClusterDeveloper, async (c) => {
  const domain = c.req.param("domain").toLowerCase();
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c));

  const record = await db.domains.get(domain);
  if (!record) {
    return c.json(
      createErrorResponse({ message: "Domain not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      404
    );
  }

  const instance = await db.instances.get(record.instanceId);
  if (!instance) {
    return c.json(
      createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      404
    );
  }

  const canWrite = await db.clusters.canWrite(session.userId, instance.clusterId);
  if (!canWrite) {
    return c.json(
      createErrorResponse({ message: "Permission denied", code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code }),
      403
    );
  }

  await db.domains.delete(domain);
  const kv = new KVStore(getKV(c));
  await kv.logEvent({
    actor: {
      id: session.userId,
      type: "user",
    },
    targets: [
      {
        id: domain,
      },
    ],
    type: EVENTS.RESOURCE.RESOURCE_DELETED.code,
    request: c.req.raw,
  });

  return c.body(null, 204);
});

// OAuth callbacks (per provider)
domains.get("/callback/:provider", async (c) => {
  const provider = c.req.param("provider") as DNSProvider;
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json(
      createErrorResponse({
        message: "Missing required query parameters",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const kv = new KVStore(getKV(c));
  const db = new DatabaseStore(getDB(c));
  const redirectPath = await kv.validateState(state);

  if (!redirectPath) {
    return c.json(
      createErrorResponse({
        message: "Invalid OAuth state",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  try {
    const domainMatch = redirectPath.match(/domain=([^&]+)/);
    if (!domainMatch) {
      return c.json(
        createErrorResponse({
          message: "Invalid or missing domain in redirect state",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    const domain = decodeURIComponent(domainMatch[1]);
    const domainRecord = await db.domains.get(domain);

    if (!domainRecord) {
      return c.json(
        createErrorResponse({
          message: "Domain not found",
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }

    const oauthKey = `dns:oauth:${domain}:${provider}`;
    await kv.kv.put(oauthKey, JSON.stringify({
      code,
      provider,
      domain,
      createdAt: Date.now(),
    }), {
      ttl: 3600, // 1 hour
    });

    const url = new URL(`${c.env.APP_URL}${redirectPath}`);
    url.searchParams.set("oauth", provider);
    url.searchParams.set("status", "authorized");
    return c.redirect(url.toString());
  } catch (err) {
    console.error("OAuth callback error:", err);
    return c.json(
      createErrorResponse({
        message: "OAuth callback failed",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

export default domains;
