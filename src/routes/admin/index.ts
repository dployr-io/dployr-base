// routes/admin/admin.ts
import { Hono } from "hono";
import { Bindings, createErrorResponse, createSuccessResponse, Variables } from "@/types/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { getKV } from "@/lib/context.js";
import { requireDployrAdministrator, requireDployrAdministratorIPAddress } from "@/middleware/auth.js";
import instances from "./instances.js";
import * as OTPAuth from "otpauth";
import { ADMIN_JWT_TTL, ERROR } from "@/lib/constants/index.js";
import { readFileSync } from "fs";
import { join } from "path";

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
    }
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
        code: "CONFIG_MISSING",
      }),
      500,
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
  const ttl = ADMIN_JWT_TTL;

  const kv = new KVStore(getKV(c));
  const token = await kv.createAdminJWT(sessionId, ttl);

  await kv.saveAdminJWT(sessionId, token, ttl);

  return c.json(createSuccessResponse({ token, expiresIn: ttl, sessionId }));
});

// Apply IP whitelist and admin middleware
admin.use("/instances/*", requireDployrAdministratorIPAddress);
admin.use("/instances/*", requireDployrAdministrator);
admin.route("/instances", instances);

export default admin;
