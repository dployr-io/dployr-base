// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { ERROR, DEFAULT_EVENTS } from "@/lib/constants/index.js";
import { requireClusterDeveloper } from "@/middleware/auth.js";
import { getDbStore } from "@/lib/config/context.js";
import z from "zod";

const notifications = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const setupSchema = z.object({
  integration: z.enum(["discord", "slack", "customWebhook", "email"]),
  events: z.array(z.string()),
});

// Notification events subscription management
notifications.post("/events/setup", requireClusterDeveloper, async (c) => {
  try {
    const body = await c.req.json();
    const validation = setupSchema.safeParse(body);

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

    const { integration, events } = validation.data;

    const clusterId = c.req.query("clusterId");

    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "Missing clusterId query parameter",
          code: ERROR.AUTH.BAD_SESSION.code,
        }),
        ERROR.AUTH.BAD_SESSION.status,
      );
    }
    const db = getDbStore(c);
    const cluster = await db.clusters.get(clusterId);

    const metadata = (cluster?.metadata as Record<string, any>) || {};

    if (integration === "email") {
      const current = (metadata.emailNotification as Record<string, any>) || {};
      await db.clusters.update(clusterId, {
        metadata: {
          emailNotification: {
            ...current,
            events,
          },
        },
      });
    } else {
      const key = integration as "discord" | "slack" | "customWebhook";
      const current = (metadata[key] as Record<string, any>) || {};
      await db.clusters.update(clusterId, {
        metadata: {
          [key]: {
            ...current,
            events,
          },
        } as Record<string, any>,
      });
    }

    return c.json(createSuccessResponse({ integration, events }, "Notification events updated"));
  } catch (error) {
    console.error("[Notifications] Notification events setup error:", error);
    return c.json(
      createErrorResponse({
        message: "Internal server error",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Discord integration setup
notifications.post("/discord/setup", requireClusterDeveloper, async (c) => {
  try {
    const { webhookUrl, enabled, events } = await c.req.json();
    const clusterId = c.req.query("clusterId");

    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "Missing clusterId query parameter",
          code: ERROR.AUTH.BAD_SESSION.code,
        }),
        ERROR.AUTH.BAD_SESSION.status,
      );
    }

    const db = getDbStore(c);
    await db.clusters.update(clusterId, {
      metadata: { discord: { webhookUrl, enabled, events: events || DEFAULT_EVENTS } },
    });

    return c.json(createSuccessResponse({ webhookUrl, enabled, events: events || DEFAULT_EVENTS }, "Discord integration configured"));
  } catch (error) {
    console.error("[Notifications] Discord setup error:", error);
    return c.json(
      createErrorResponse({
        message: "Internal server error",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Slack integration setup
notifications.post("/slack/setup", requireClusterDeveloper, async (c) => {
  try {
    const { webhookUrl, enabled, events } = await c.req.json();
    const clusterId = c.req.query("clusterId");

    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "Missing clusterId query parameter",
          code: ERROR.AUTH.BAD_SESSION.code,
        }),
        ERROR.AUTH.BAD_SESSION.status,
      );
    }

    const db = getDbStore(c);
    await db.clusters.update(clusterId, {
      metadata: { slack: { webhookUrl, enabled, events: events || DEFAULT_EVENTS } },
    });

    return c.json(createSuccessResponse({ webhookUrl, enabled, events: events || DEFAULT_EVENTS }, "Slack integration configured"));
  } catch (error) {
    console.error("[Notifications] Slack setup error:", error);
    return c.json(
      createErrorResponse({
        message: "Internal server error",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Custom webhook integration setup
notifications.post("/webhook/setup", requireClusterDeveloper, async (c) => {
  try {
    const { webhookUrl, enabled, events } = await c.req.json();
    const clusterId = c.req.query("clusterId");

    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "Missing clusterId query parameter",
          code: ERROR.AUTH.BAD_SESSION.code,
        }),
        ERROR.AUTH.BAD_SESSION.status,
      );
    }

    const db = getDbStore(c);
    await db.clusters.update(clusterId, {
      metadata: { customWebhook: { webhookUrl, enabled, events: events || DEFAULT_EVENTS } },
    });

    return c.json(createSuccessResponse({ webhookUrl, enabled, events: events || DEFAULT_EVENTS }, "Custom webhook integration configured"));
  } catch (error) {
    console.error("[Notifications] Webhook setup error:", error);
    return c.json(
      createErrorResponse({
        message: "Internal server error",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Email notification setup
notifications.post("/email/setup", requireClusterDeveloper, async (c) => {
  try {
    const { enabled, events } = await c.req.json();
    const clusterId = c.req.query("clusterId");

    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "Missing clusterId query parameter",
          code: ERROR.AUTH.BAD_SESSION.code,
        }),
        ERROR.AUTH.BAD_SESSION.status,
      );
    }

    const db = getDbStore(c);
    await db.clusters.update(clusterId, {
      metadata: { emailNotification: { enabled, events } },
    });

    return c.json(createSuccessResponse({ enabled, events }, "Email notification configured"));
  } catch (error) {
    console.error("[Notifications] Email notification setup error:", error);
    return c.json(
      createErrorResponse({
        message: "Internal server error",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

export default notifications;
