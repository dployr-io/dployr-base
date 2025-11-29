// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types";
import { D1Store } from "@/lib/db/store";
import { ERROR, DEFAULT_EVENTS } from "@/lib/constants";
import { authMiddleware, requireClusterDeveloper } from "@/middleware/auth";

const notifications = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
    const d1 = new D1Store(c.env.BASE_DB);
    const cluster = await d1.clusters.get(clusterId);

    const metadata = (cluster?.metadata as Record<string, any>) || {};

    if (integration === "email") {
      const current = (metadata.emailNotification as Record<string, any>) || {};
      await d1.clusters.update(clusterId, {
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
      await d1.clusters.update(clusterId, {
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

    const d1 = new D1Store(c.env.BASE_DB);
    await d1.clusters.update(session.clusters[0].id, {
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

    const d1 = new D1Store(c.env.BASE_DB);
    await d1.clusters.update(session.clusters[0].id, {
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

    const d1 = new D1Store(c.env.BASE_DB);
    await d1.clusters.update(session.clusters[0].id, {
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

    const d1 = new D1Store(c.env.BASE_DB);
    await d1.clusters.update(session.clusters[0].id, {
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
