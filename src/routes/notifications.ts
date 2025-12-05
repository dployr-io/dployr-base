// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { ERROR, DEFAULT_EVENTS } from "@/lib/constants/index.js";
import { authMiddleware, requireClusterDeveloper } from "@/middleware/auth.js";
import { getDB, type AppVariables } from "@/lib/context.js";

const notifications = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

notifications.use("*", authMiddleware);

// Notification events subscription management
notifications.post("/events/setup", requireClusterDeveloper, async (c) => {
  try {
    const { integration, events } = await c.req.json<{
      integration: "discord" | "slack" | "customWebhook" | "email";
      events: string[];
    }>();

    const session = c.get("session");

    if (!session?.clusters?.[0]?.id) {
      return c.json(
        createErrorResponse({
          message: "No cluster found",
          code: ERROR.AUTH.BAD_SESSION.code,
        }),
        ERROR.AUTH.BAD_SESSION.status,
      );
    }

    const clusterId = session.clusters[0].id;
    const db = new DatabaseStore(getDB(c) as any);
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
    console.error("Notification events setup error:", error);
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
    const session = c.get("session");
    
    if (!session?.clusters?.[0]?.id) {
      return c.json(createErrorResponse({ 
        message: "No cluster found", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const db = new DatabaseStore(getDB(c) as any);
    await db.clusters.update(session.clusters[0].id, {
      metadata: { discord: { webhookUrl, enabled, events: events || DEFAULT_EVENTS } }
    });

    return c.json(createSuccessResponse({ webhookUrl, enabled, events: events || DEFAULT_EVENTS }, "Discord integration configured"));
  } catch (error) {
    console.error("Discord setup error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Slack integration setup
notifications.post("/slack/setup", requireClusterDeveloper, async (c) => {
  try {
    const { webhookUrl, enabled, events } = await c.req.json();
    const session = c.get("session");
    
    if (!session?.clusters?.[0]?.id) {
      return c.json(createErrorResponse({ 
        message: "No cluster found", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const db = new DatabaseStore(getDB(c) as any);
    await db.clusters.update(session.clusters[0].id, {
      metadata: { slack: { webhookUrl, enabled, events: events || DEFAULT_EVENTS } }
    });

    return c.json(createSuccessResponse({ webhookUrl, enabled, events: events || DEFAULT_EVENTS }, "Slack integration configured"));
  } catch (error) {
    console.error("Slack setup error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Custom webhook integration setup
notifications.post("/webhook/setup", requireClusterDeveloper, async (c) => {
  try {
    const { webhookUrl, enabled, events } = await c.req.json();
    const session = c.get("session");
    
    if (!session?.clusters?.[0]?.id) {
      return c.json(createErrorResponse({ 
        message: "No cluster found", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const db = new DatabaseStore(getDB(c) as any);
    await db.clusters.update(session.clusters[0].id, {
      metadata: { customWebhook: { webhookUrl, enabled, events: events || DEFAULT_EVENTS } }
    });

    return c.json(createSuccessResponse({ webhookUrl, enabled, events: events || DEFAULT_EVENTS }, "Custom webhook integration configured"));
  } catch (error) {
    console.error("Webhook setup error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Email notification setup
notifications.post("/email/setup", requireClusterDeveloper, async (c) => {
  try {
    const { enabled, events } = await c.req.json();
    const session = c.get("session");
    
    if (!session?.clusters?.[0]?.id) {
      return c.json(createErrorResponse({ 
        message: "No cluster found", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const db = new DatabaseStore(getDB(c) as any);
    await db.clusters.update(session.clusters[0].id, {
      metadata: { emailNotification: { enabled, events } }
    });

    return c.json(createSuccessResponse({ enabled, events }, "Email notification configured"));
  } catch (error) {
    console.error("Email notification setup error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default notifications;
