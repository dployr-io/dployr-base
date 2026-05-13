// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ulid } from "ulid";
import type { Bindings, Variables } from "@/types/index.js";
import { getDbStore, getKVStore, getWS } from "@/lib/config/context.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { SERVICE_WAKING_TTL } from "@/lib/constants/duration.js";
import { DployrdService } from "@/services/dployrd.js";
import { JWTService } from "@/services/auth/jwt.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("status");
const dployrdService = new DployrdService();
const status = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Public endpoint — no auth required.
 * Accepts ?domain=<hostname>
 * Returns { status: "ready" | "starting" | "not_found" }
 *
 * On first hit while a service is sleeping, fires a wake task so the
 * loading page can poll until the service is back up.
 */
status.get("/", async (c) => {
  const domain = c.req.query("domain");
  if (!domain) {
    return c.json({ status: "not_found" }, 400);
  }

  const db = getDbStore(c);
  const kv = getKVStore(c);
  const { connectionManager } = getWS(c);

  // 1. Resolve service + cluster from domain
  let clusterId: string | null = null;
  let serviceName: string | null = null;

  // Try custom domain table first
  const customDomain = await db.domains.find(domain);
  if (customDomain) {
    clusterId = customDomain.clusterId;
  } else {
    // Fall back to subdomain pattern: {name}.{tld}
    const tld = c.env.TLD ?? "dployr.io";
    if (domain.endsWith(`.${tld}`)) {
      serviceName = domain.slice(0, -(tld.length + 1));
    }
  }

  // If we have a clusterId from custom domain, get the service name
  if (clusterId && !serviceName) {
    const { services } = await db.services.list({ clusterId });
    if (services.length === 0) return c.json({ status: "not_found" });
    serviceName = services[0].name;
  }

  if (!serviceName) return c.json({ status: "not_found" });

  // 2. If not found by name, try DB lookup
  if (!clusterId) {
    const service = await db.services.find({ name: serviceName });
    if (!service) return c.json({ status: "not_found" });
    clusterId = service.clusterId;
  }

  // 3. Already waking — container is starting, not yet ready
  const waking = await kv.kv.get(KV_KEYS.SERVICE.WAKING(serviceName));
  if (waking) {
    return c.json({ status: "starting" });
  }

  // 4. Check sleeping state
  const sleeping = await kv.kv.get(KV_KEYS.SERVICE.SLEEPING(serviceName));
  if (!sleeping) {
    return c.json({ status: "ready" });
  }

  // 5. Service is sleeping — fire wake task and transition to waking state
  try {
    const routingKey = await db.instances.getRoutingKey(clusterId);
    if (routingKey) {
      const jwtService = new JWTService(kv);
      const taskId = ulid();
      const token = await jwtService.createNodeAccessToken(routingKey, { issuer: c.env.BASE_URL, audience: "dployr-instance" });
      const task = dployrdService.createServiceWakeTask(taskId, serviceName, token);
      connectionManager.sendTask(routingKey, task);

      // Clear sleeping, set waking with 90s TTL (covers docker start time)
      await kv.kv.delete(KV_KEYS.SERVICE.SLEEPING(serviceName));
      await kv.kv.put(KV_KEYS.SERVICE.WAKING(serviceName), "1", { ttl: SERVICE_WAKING_TTL });
      await kv.kv.put(KV_KEYS.SERVICE.LAST_ACTIVE(serviceName), String(Date.now()));
    }
  } catch (err) {
    log.warn(`Failed to dispatch wake task for ${serviceName}`, { error: String(err) });
  }

  return c.json({ status: "starting" });
});

export default status;
