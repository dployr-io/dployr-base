// routes/admin/admin.ts
import { Hono } from "hono";
import * as OTPAuth from "otpauth";
import { readFileSync } from "fs";
import { join } from "path";
import { Bindings, createErrorResponse, createSuccessResponse, Variables } from "@/types/index.js";
import { getKVStore, getDbStore } from "@/lib/config/context.js";
import { requireDployrAdministrator, requireDployrAdministratorIPAddress } from "@/middleware/auth.js";
import instances from "./instances/index.js";
import { ADMIN_JWT_TTL, ERROR } from "@/lib/constants/index.js";
import { getVMService } from "@/lib/config/context.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("admin");
const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply IP whitelist and admin middleware
admin.use("*", requireDployrAdministratorIPAddress);

// Config endpoint - provides runtime configuration to dployr admin
admin.get("/config.js", (c) => {
  return c.text(
    `window.__CONFIG__ = ${JSON.stringify({
      API_BASE: c.env.BASE_URL,
    })};`,
    200,
    {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store",
    },
  );
});

// Serve static admin page
admin.get("/", async (c) => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf-8");
  return c.html(html);
});

admin.post("/login", async (c) => {
  const { api_key, otp_code, session_id } = await c.req.json().catch(() => ({}));

  const errorRes = c.json(
    createErrorResponse({
      message: "Invalid credentials",
      code: ERROR.AUTH.BAD_TOKEN.code,
    }),
    ERROR.AUTH.BAD_TOKEN.status,
  );

  if (!c.env.ADMIN_TOTP_SECRET) {
    return c.json(
      createErrorResponse({
        message: "TOTP secret not configured",
        code: ERROR.RUNTIME.ADMIN_TOTP_NOT_CONFIGURED.code,
      }),
      ERROR.RUNTIME.ADMIN_TOTP_NOT_CONFIGURED.status,
    );
  }

  if (api_key !== c.env.ADMIN_API_KEY || !otp_code || !/^\d{6}$/.test(otp_code)) {
    return errorRes;
  }

  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(c.env.ADMIN_TOTP_SECRET),
  });

  // validate OTP (±30s window)
  if (totp.validate({ token: otp_code, window: 1 }) === null) {
    return errorRes;
  }

  const sessionId = session_id ?? `adm_${crypto.randomUUID().slice(0, 8)}`;
  // 7 days in dev mode, 30 minutes in prod (set in ADMIN_JWT_TTL)
  const ttl =
    process.env.NODE_ENV === "development"
      ? 604800 // 7 days in s
      : ADMIN_JWT_TTL; // e.g., "30m"

  const kv = getKVStore(c);
  const token = await kv.createAdminJWT({ sessionId, ttl });

  await kv.saveAdminJWT({ sessionId, token, ttl });

  return c.json(createSuccessResponse({ token, expiresIn: ttl, sessionId }));
});

admin.use("*", requireDployrAdministrator);

admin.get("/events", async (c) => {
  const kv = getKVStore(c);
  const events = await kv.getAllEvents();
  return c.json(createSuccessResponse({ events }));
});

admin.get("/deployments", async (c) => {
  const db = getDbStore(c);
  const { deployments, total } = await db.deployments.list({});
  return c.json(createSuccessResponse({ deployments, total }));
});

admin.get("/services", async (c) => {
  const db = getDbStore(c);
  const { services, total } = await db.services.list();
  return c.json(createSuccessResponse({ services, total }));
});

/**
 * Admin endpoint: delete instance AND VM droplet.
 * Protected by requireDployrAdministrator middleware.
 * Accepts instance ID or tag name.
 */
admin.delete("/remove-instance/:id", async (c) => {
  const identifier = c.req.param("id");
  const db = getDbStore(c);
  const vm = getVMService(c);

  try {
    let instance = await db.instances.find({ id: identifier });
    if (!instance) {
      instance = await db.instances.find({ tag: identifier });
    }

    if (!instance) {
      return c.json(
        createErrorResponse({
          message: "Instance not found",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    try {
      await vm.delete(instance.tag);
    } catch (err: any) {
      log.error(`Failed to delete VM: ${err.message}`);
      throw err;
    }

    await db.instances.delete({ id: instance.id });

    return c.json(createSuccessResponse({ deleted: true, instance: instance.tag }));
  } catch (err: any) {
    return c.json(
      createErrorResponse({
        message: "Failed to delete instance",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }
});

admin.route("/instances", instances);

export default admin;
