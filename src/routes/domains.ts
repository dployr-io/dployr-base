// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { Bindings, Variables, createErrorResponse, createSuccessResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { authMiddleware, requireClusterViewer, requireClusterDeveloper, resolveCluster } from "@/middleware/auth.js";
import { getDbStore, getKVStore, getDnsService, getInstanceService, getTraefikRouterService } from "@/lib/config/context.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Domains");

const domains = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();

const registerInstanceSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

const setupSchema = z.object({
  domain: z
    .string()
    .min(3, "Domain must be at least 3 characters")
    .max(253, "Domain must be at most 253 characters")
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "Invalid domain format"),
  clusterId: z.ulid("Invalid cluster ID"),
  serviceName: z.string().min(1, "Service name is required"),
});

// Register instance with bootstrap token (this method is called by dployrd when a new node is brought online)
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
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    const { token } = validation.data;
    const result = await getInstanceService(c).registerInstance({ token, c });

    if (!result.ok) {
      if (result.reason === "invalid_token") {
        return c.json(
          createErrorResponse({
            message: "Invalid or expired token",
            code: ERROR.AUTH.BAD_TOKEN.code,
          }),
          ERROR.AUTH.BAD_TOKEN.status,
        );
      }

      if (result.reason === "invalid_type") {
        return c.json(
          createErrorResponse({
            message: "Invalid token type",
            code: ERROR.AUTH.BAD_TOKEN.code,
          }),
          ERROR.AUTH.BAD_TOKEN.status,
        );
      }

      return c.json(
        createErrorResponse({
          message: "Token already used",
          code: ERROR.AUTH.BAD_TOKEN.code,
        }),
        ERROR.AUTH.BAD_TOKEN.status,
      );
    }

    const domain = await getInstanceService(c).saveDomain({
      instanceName: result.instanceName,
      c,
    });

    // Get instance to include ID in response for Dployrd version compatibility
    const db = getDbStore(c);
    const instance = await db.instances.find({ tag: result.instanceName });
    if (!instance) {
      throw new Error("Instance not found after domain save");
    }

    const kv = getKVStore(c);
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
      }),
    );
  } catch (error) {
    log.error("Failed to register instance", error);
    return c.json(
      createErrorResponse({
        message: "Instance registration failed",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Create custom domain
domains.post("/", authMiddleware, requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const dns = getDnsService(c);
  const body = await c.req.json();
  const validation = setupSchema.safeParse(body);
  if (!validation.success) {
    const msg = validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    return c.json(createErrorResponse({ message: msg, code: ERROR.REQUEST.BAD_REQUEST.code }), 400);
  }

  const { domain, clusterId, serviceName } = validation.data;
  const normalizedDomain = domain.toLowerCase();

  // Validate service exists and belongs to the cluster
  const service = await db.services.find({ name: serviceName });
  if (!service) {
    return c.json(createErrorResponse({ message: "Service not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), 404);
  }
  if (service.clusterId !== clusterId) {
    return c.json(createErrorResponse({ message: "Service does not belong to this cluster", code: ERROR.PERMISSION.FORBIDDEN.code }), 403);
  }

  // Check domain not already claimed by another instance
  const existing = await db.domains.find(normalizedDomain);
  if (existing && existing.clusterId !== clusterId) {
    return c.json(createErrorResponse({ message: "Domain already registered to another instance", code: ERROR.RESOURCE.CONFLICT.code }), 409);
  }

  const provider = await dns.detectProvider(normalizedDomain);

  // Use existing domain data or create new
  let domainRecord = existing;
  if (!domainRecord) {
    const token = dns.generateToken();
    domainRecord = await db.domains.create({ clusterId, domain: normalizedDomain, token, provider, serviceName });
  }

  const { records, verification } = dns.buildRecordsFromStored(normalizedDomain, domainRecord.serviceName, domainRecord.verificationToken);

  return c.json(
    createSuccessResponse({
      domain: normalizedDomain,
      provider,
      records,
      verification,
      manualGuideUrl: dns.getManualGuideUrl(provider),
    }),
  );
});

// Client-initiated domain verification check
domains.post("/:domain/verify", authMiddleware, resolveCluster("domain", { path: "domain" }), requireClusterDeveloper, async (c) => {
  try {
    const domain = c.req.param("domain").toLowerCase();
    const db = getDbStore(c);
    const dns = getDnsService(c);

    const record = await db.domains.find(domain);
    if (!record) {
      return c.json(createErrorResponse({ message: "Domain not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), 404);
    }

    const verified = await dns.checkTxtRecord(domain, record.verificationToken);
    if (!verified) {
      return c.json(createErrorResponse({ message: "TXT record not found", code: ERROR.REQUEST.UNPROCESSABLE_ENTITY.code }), 422);
    }

    await db.domains.activate(domain);

    if (record.serviceName) {
      const traefik = getTraefikRouterService(c);
      if (traefik) await traefik.registerCustomDomain(domain, record.serviceName);
    }

    return c.body(null, 204);
  } catch (err) {
    log.error("Domain verification error:", err);
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
domains.get("/:domain", authMiddleware, resolveCluster("domain", { path: "domain" }), requireClusterViewer, async (c) => {
  const domain = c.req.param("domain").toLowerCase();
  const db = getDbStore(c);
  const dns = getDnsService(c);

  const domainRecord = await db.domains.find(domain);
  if (!domainRecord) {
    return c.json(createErrorResponse({ message: "Domain not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), 404);
  }

  const response: any = {
    domain: domainRecord.domain,
    status: domainRecord.status,
    clusterId: domainRecord.clusterId,
    provider: domainRecord.provider,
    createdAt: domainRecord.createdAt,
    activatedAt: domainRecord.activatedAt,
  };

  // For pending domains, include verification records
  if (domainRecord.status === "pending") {
    const { records, verification } = dns.buildRecordsFromStored(domain, domainRecord.serviceName, domainRecord.verificationToken);
    response.records = records;
    response.verification = verification;
    response.manualGuideUrl = dns.getManualGuideUrl(domainRecord.provider || "unknown");
  }

  return c.json(createSuccessResponse(response));
});

// List domains for a cluster
domains.get("/", authMiddleware, requireClusterViewer, async (c) => {
  const clusterId = c.req.query("clusterId");
  const db = getDbStore(c);
  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));

  const { domains: domainsList, total } = await db.domains.list({ clusterId, limit: pageSize, offset });
  const paginatedData = createPaginatedResponse(domainsList, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

// Remove a domain
domains.delete("/:domain", authMiddleware, resolveCluster("domain", { path: "domain" }), requireClusterDeveloper, async (c) => {
  const domain = c.req.param("domain").toLowerCase();
  const session = c.get("session")!;
  const db = getDbStore(c);

  const domainRecord = await db.domains.find(domain);
  await db.domains.delete(domain);

  if (domainRecord?.status === "active") {
    const traefik = getTraefikRouterService(c);
    if (traefik) await traefik.unregisterCustomDomain(domain);
  }
  const kv = getKVStore(c);
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

export default domains;
