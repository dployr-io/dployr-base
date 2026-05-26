// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Bindings, Variables } from "@/types/index.js";
import { createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { verifyGitHubWebhook } from "@/lib/utils.js";
import { ERROR } from "@/lib/constants/index.js";
import { getIntegrationsService } from "@/lib/config/context.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("webhooks");
const webhooks = new Hono<{ Bindings: Bindings; Variables: Variables }>();

webhooks.post("/zepto/bounce", async (c) => {
  const secret = c.env.LISTMONK_BOUNCE_WEBHOOK_SECRET;
  if (secret) {
    const authHeader = c.req.header("authorization") || "";
    const incoming = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!incoming || incoming !== secret) {
      log.warn("Bounce webhook: invalid or missing Authorization header");
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const eventName: string = (body.event_name?.[0] ?? "").toLowerCase();
  const msg = body.event_message?.[0] ?? {};

  if (!eventName.includes("bounce") && !eventName.includes("feedbackloop")) {
    // Not a bounce event — ZeptoMail may send other events; ignore silently
    return c.json({ ok: true, skipped: true });
  }

  const isHard = eventName === "hardbounce";
  const isFeedback = eventName === "feedbackloop";
  const bounceType: "hard" | "soft" | "complaint" =
    isFeedback ? "complaint" : isHard ? "hard" : "soft";

  // Prefer bounce_info.bounce_address; fall back to email_info.to[0]
  const email: string | undefined =
    msg.bounce_info?.bounce_address ||
    msg.email_info?.to?.[0]?.email_address?.address ||
    msg.email_info?.to?.[0]?.address;

  if (!email) {
    log.warn("Bounce webhook: could not extract email from payload", { body });
    return c.json({ ok: true, skipped: true });
  }

  // Soft bounces are transient — don't blocklist
  if (bounceType === "soft") {
    log.info(`Bounce webhook: soft bounce for ${email} — skipping`);
    return c.json({ ok: true, skipped: true });
  }

  const lmUser = c.env.LISTMONK_ADMIN_USER;
  const lmPass = c.env.LISTMONK_ADMIN_PASSWORD;

  if (!lmUser || !lmPass) {
    log.warn("Bounce webhook: Listmonk credentials not configured");
    return c.json({ error: "Listmonk not configured" }, 503);
  }

  const lmApi = "http://localhost:9000/api";
  const auth = Buffer.from(`${lmUser}:${lmPass}`).toString("base64");

  try {
    const resp = await fetch(`${lmApi}/bounces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        email,
        source: "api",
        type: bounceType,
        meta: { raw: body },
      }),
    });

    if (resp.ok) {
      log.info(`Bounce recorded and blocklisted: ${email} (${bounceType})`);
      return c.json({ ok: true });
    }

    const errText = await resp.text().catch(() => "");
    log.error(`Listmonk bounce API returned ${resp.status}`, { errText });
    return c.json({ error: "Listmonk API error" }, 502);
  } catch (err: any) {
    log.error("Bounce webhook: failed to reach Listmonk", { error: err?.message });
    return c.json({ error: "Could not reach Listmonk" }, 502);
  }
});

webhooks.post("/github", async (c) => {
  try {
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");
    const payload = await c.req.text();
    const body = JSON.parse(payload);

    if (!signature) {
      return c.json(
        createErrorResponse({ message: "Missing signature", code: ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.code }),
        ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.status,
      );
    }

    const isValid = await verifyGitHubWebhook({ payload, signature, secret: c.env.GITHUB_WEBHOOK_SECRET });
    if (!isValid) {
      return c.json(
        createErrorResponse({ message: "Invalid signature", code: ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.code }),
        ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.status,
      );
    }

    const integrationsService = getIntegrationsService(c);

    if (event === "installation" && body.action === "created") {
      await integrationsService.handleGitHubInstallation(body);
    }
    if (event === "meta" && body.action === "deleted") {
      await integrationsService.handleGitHubMeta(body);
    }
    if (event === "workflow_run") {
      await integrationsService.handleGitHubWorkflowRun(body);
    }
    if (event === "push") {
      await integrationsService.handleGitHubPush(body);
    }

    return c.json(createSuccessResponse({}, "Webhook processed"));
  } catch (error) {
    log.error("GitHub webhook error:", error);
    return c.json(
      createErrorResponse({ message: "Internal server error", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code, helpLink: "https://monitoring.dployr.io" }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

export default webhooks;
