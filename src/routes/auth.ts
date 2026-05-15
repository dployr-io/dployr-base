// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, OAuthProvider, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { setCookie, getCookie } from "hono/cookie";
import z from "zod";
import { sanitizeReturnTo } from "@/lib/utils.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { getKVStore, getOAuthService, getDbStore, getJWTService, getEmailService, getAuthService, getInstancePoolService } from "@/lib/config/context.js";
import { worker } from "@/services/background/index.js";
import { notify } from "@/services/background/jobs/notify.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Auth");

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const loginSchema = z.object({
  email: z.email(),
});

const otpSchema = z.object({
  email: z.email(),
  code: z.string().min(6).max(6),
});

function setSessionCookie(c: any, sessionId: string) {
  const url = new URL(c.req.url);
  const isDployrHost = url.hostname === "dployr.io" || url.hostname.endsWith(".dployr.io");
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
    ...(isDployrHost ? { domain: ".dployr.io" } : {}),
  });
}

// Initiate OAuth flow
auth.get("/login/:provider", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;

  if (!["google", "github", "microsoft"].includes(provider)) {
    return c.json(
      createErrorResponse({ message: "Invalid provider", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const oauth = getOAuthService(c);
  const kv = getKVStore(c);
  const state = crypto.randomUUID();
  const returnTo = c.req.query("redirect_to") || "/dashboard";
  const redirectUrl = sanitizeReturnTo(returnTo);

  await kv.createState({ state, redirectUrl });

  return c.redirect(oauth.getAuthUrl(provider, state));
});

// OAuth callback
auth.get("/callback/:provider", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json(
      createErrorResponse({ message: "Missing code or state", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const kv = getKVStore(c);
  const redirectUrl = await kv.validateState(state);

  if (!redirectUrl) {
    return c.json(
      createErrorResponse({ message: "Invalid state", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  try {
    const oauth = getOAuthService(c);
    const authService = getAuthService(c);

    const accessToken = await oauth.exchangeCode({ provider, code });
    const oAuthUser = await oauth.getUserInfo({ provider, accessToken });

    const user = await authService.loginWithOAuth({
      email: oAuthUser.email,
      provider,
      name: oAuthUser.name ?? oAuthUser.email.split("@")[0],
      picture: oAuthUser.picture,
      metadata: oAuthUser.metadata,
    });

    const vmService = c.get("vmProvider") ?? undefined;
    await authService.provisionCluster({ userId: user.id, vmService, jwt: getJWTService(c), pool: getInstancePoolService(c) });
    const { sessionId, clusters } = await authService.createSession({ user });

    await kv.logEvent({
      actor: { id: user.id, type: "user" },
      targets: clusters.map((cl) => ({ id: cl.id })),
      type: EVENTS.AUTH.SESSION_CREATED.code,
      request: c.req.raw,
    });

    setSessionCookie(c, sessionId);

    if (clusters.length > 0) {
      worker.dispatch(notify(EVENTS.AUTH.SESSION_CREATED.code, { clusterId: clusters[0].id, userEmail: user.email }));
    }

    return c.redirect(c.env.APP_URL);
  } catch (error) {
    log.error("OAuth error:", error);
    return c.redirect(`${c.env.APP_URL}/?authError=${encodeURIComponent(`Failed to sign-in with ${provider}. Try email instead.`)}`);
  }
});

// Email authentication - Send OTP
auth.post("/login/email", async (c) => {
  const data = await c.req.json();
  const validation = loginSchema.safeParse(data);

  if (!validation.success) {
    return c.json(
      createErrorResponse({ message: "Invalid email format", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { email } = validation.data;
  const authService = getAuthService(c);

  await authService.findOrCreateEmailUser({ email });

  const isTestEnv = process.env.NODE_ENV === "test";
  if (!isTestEnv) {
    try {
      await authService.sendOTP({ email, emailService: getEmailService(c) });
    } catch (error) {
      log.error("Send OTP error:", error);
      return c.json(
        createErrorResponse({ message: "Failed to send code. Wait a few moments and try again.", code: ERROR.REQUEST.BAD_REQUEST.code }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }
  }

  return c.json(createSuccessResponse({ email }, "OTP sent to your email"));
});

// Email authentication - Verify OTP
auth.post("/login/email/verify", async (c) => {
  const data = await c.req.json();
  const validation = otpSchema.safeParse(data);

  if (!validation.success) {
    return c.json(
      createErrorResponse({ message: "Invalid email or code format", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { email, code } = validation.data;
  const authService = getAuthService(c);
  const db = getDbStore(c);
  const kv = getKVStore(c);

  const isTestEnv = process.env.NODE_ENV === "test";
  const isValid = isTestEnv || await authService.verifyOTP({ email, code });
  if (!isValid) {
    return c.json(
      createErrorResponse({ message: "Invalid or expired code", code: ERROR.REQUEST.INVALID_OTP.code }),
      ERROR.REQUEST.INVALID_OTP.status,
    );
  }

  const user = await db.users.find({ email });
  if (!user) {
    return c.json(
      createErrorResponse({ message: "User not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  const vmService = c.get("vmProvider") ?? undefined;
  await authService.provisionCluster({ userId: user.id, vmService, jwt: getJWTService(c), pool: getInstancePoolService(c) });

  const { sessionId, clusters } = await authService.createSession({ user });

  await kv.logEvent({
    actor: { id: user.id, type: "user" },
    targets: clusters.map((cl) => ({ id: cl.id })),
    type: EVENTS.AUTH.SESSION_CREATED.code,
    request: c.req.raw,
  });

  setSessionCookie(c, sessionId);

  if (clusters.length > 0) {
    worker.dispatch(notify(EVENTS.AUTH.SESSION_CREATED.code, { clusterId: clusters[0].id, userEmail: user.email }));
  }

  return c.json(createSuccessResponse({ email }, "Login successful"));
});

// Logout
auth.get("/logout", async (c) => {
  const sessionId = getCookie(c, "session");

  if (sessionId) {
    const kv = getKVStore(c);
    await kv.deleteSession(sessionId);
  }

  const url = new URL(c.req.url);
  const isDployrHost = url.hostname === "dployr.io" || url.hostname.endsWith(".dployr.io");

  setCookie(c, "session", "", {
    maxAge: 0,
    path: "/",
    ...(isDployrHost ? { domain: ".dployr.io" } : {}),
  });

  return c.json(createSuccessResponse({}, "Logged out successfully"));
});

export default auth;
