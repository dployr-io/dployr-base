// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, OAuthProvider, createSuccessResponse, createErrorResponse, Cluster } from "@/types/index.js";
import { OAuthService } from "@/services/oauth.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { setCookie, getCookie } from "hono/cookie";
import { DatabaseStore } from "@/lib/db/store/index.js";
import z from "zod";
import { sanitizeReturnTo } from "@/services/utils.js";
import { EmailService } from "@/services/email.js";
import { loginCodeTemplate } from "@/lib/templates/emails/verificationCode.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { NotificationService } from "@/services/notifications.js";
import { getKV, getDB, runBackground, type AppVariables } from "@/lib/context.js";

const auth = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

const loginSchema = z.object({
  email: z.email(),
});

const otpSchema = z.object({
  email: z.email(),
  code: z.string().min(6).max(6),
});

// Initiate OAuth flow
auth.get("/login/:provider", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;

  if (!["google", "github", "microsoft"].includes(provider)) {
    return c.json(createErrorResponse({
      message: "Invalid provider",
      code: ERROR.REQUEST.BAD_REQUEST.code
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const oauth = new OAuthService(c.env);
  const kv = new KVStore(getKV(c));
  const state = crypto.randomUUID();
  const returnTo = c.req.query("redirect_to") || "/dashboard";
  const redirectUrl = sanitizeReturnTo(returnTo);

  console.log(redirectUrl)

  await kv.createState(state, redirectUrl);

  const authUrl = oauth.getAuthUrl(provider, state);

  return c.redirect(authUrl);
});

// OAuth callback
auth.get("/callback/:provider", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json(
      createErrorResponse({
        message: "Missing code or state",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const kv = new KVStore(getKV(c));
  const db = new DatabaseStore(getDB(c));

  const redirectUrl = await kv.validateState(state);

  if (!redirectUrl) {
    return c.json(
      createErrorResponse({
        message: "Invalid state",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  try {
    const oauth = new OAuthService(c.env);
    const accessToken = await oauth.exchangeCode({ provider, code });
    const oAuthUser = await oauth.getUserInfo({ provider, accessToken });

    let existingUser = await db.users.get(oAuthUser.email);

    const userToSave = existingUser
      ? {
          email: oAuthUser.email,
          name: existingUser.name,
          provider,
          metadata: oAuthUser.metadata || {},
        }
      : {
          email: oAuthUser.email,
          name: oAuthUser.name,
          picture: oAuthUser.picture,
          provider,
          metadata: oAuthUser.metadata || {},
        };

    const savedUser = await db.users.save(userToSave);

    if (!savedUser) {
      return c.json(
        createErrorResponse({
          message: "Failed to save user",
          code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        }),
        ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
      );
    }

    const sessionId = crypto.randomUUID();
    const clusters = await db.clusters.listUserClusters(savedUser.id);
    await kv.createSession(sessionId, savedUser, clusters);

    const url = new URL(c.req.url);
    const hostname = url.hostname;
    const isDployrHost = hostname === "dployr.io" || hostname.endsWith(".dployr.io");

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7,
      path: "/",
      ...(isDployrHost ? { domain: ".dployr.io" } : {}),
    });

    await kv.logEvent({
      actor: {
        id: savedUser.id,
        type: "user",
      },
      targets: clusters.map((cluster: any) => ({ id: cluster.id })),
      type: EVENTS.AUTH.SESSION_CREATED.code,
      request: c.req.raw,
    });

    // Trigger notifications
    if (clusters.length > 0) {
      const notificationService = new NotificationService(c.env);
      runBackground(
        notificationService.triggerEvent(EVENTS.AUTH.SESSION_CREATED.code, {
          clusterId: clusters[0].id,
          userEmail: savedUser.email,
        }, db)
      );
    }

    return c.redirect(c.env.APP_URL);
  } catch (error) {
    console.error("OAuth error:", error);
    return c.redirect(
      `${c.env.APP_URL}/?authError=${encodeURIComponent(
        `Failed to sign-in with ${provider}. Try email instead.`,
      )}`,
    );
  }
});

// Email authentication - Send OTP
auth.post("/login/email", async (c) => {
  try {
    const data = await c.req.json();
    const { email } = data;
    const validation = loginSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({
        message: "Invalid email format " + errors,
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const kv = new KVStore(getKV(c));
    const db = new DatabaseStore(getDB(c));

    let user = await db.users.get(email);
    if (!user) {
      const derivedName = email.split("@")[0] || email;
      await db.users.save({
        email,
        name: derivedName,
        provider: "email" as OAuthProvider,
        metadata: {},
      });
    }

    const code = await kv.createOTP(email);
    const name = email.split('@')[0]
    const emailService = new EmailService({
      env: c.env,
      to: email,
    });

    try {
      await emailService.sendEmail("Verify your account", loginCodeTemplate(name, code))
    } catch (error) {
      console.error("Send OTP error:", error);
      return c.json(createErrorResponse({
        message: "Failed to send code. Wait a few moments and try again.",
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    return c.json(createSuccessResponse({ email }, "OTP sent to your email"));
  } catch (error) {
    console.error("Send OTP error:", error);
    return c.json(createErrorResponse({
      message: "Failed to send code. Wait a few moments and try again.",
      code: ERROR.REQUEST.BAD_REQUEST.code
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }
});

// Email with magic code - Verify OTP
auth.post("/login/email/verify", async (c) => {
  try {
    const data = await c.req.json();
    const { email, code } = data;

    const validation = otpSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({
        message: "Invalid email or code format " + errors,
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const kv = new KVStore(getKV(c));
    const db = new DatabaseStore(getDB(c));
    const isValid = await kv.validateOTP(email, code.toUpperCase());

    if (!isValid) {
      return c.json(createErrorResponse({
        message: "Invalid or expired code",
        code: ERROR.REQUEST.INVALID_OTP.code
      }), ERROR.REQUEST.INVALID_OTP.status);
    }

    let user = await db.users.get(email);
    if (!user) {
      return c.json(createErrorResponse({
        message: "User not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code
      }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    const sessionId = crypto.randomUUID();
    const clusters = await db.clusters.listUserClusters(user.id);
    await kv.createSession(sessionId, user, clusters);

    await kv.logEvent({
      actor: {
        id: user.id,
        type: "user",
      },
      targets: clusters.map((cluster: any) => ({ id: cluster.id })),
      type: EVENTS.AUTH.SESSION_CREATED.code,
      request: c.req.raw,
    });

    const url = new URL(c.req.url);
    const hostname = url.hostname;
    const isDployrHost = hostname === "dployr.io" || hostname.endsWith(".dployr.io");

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
      ...(isDployrHost ? { domain: ".dployr.io" } : {}),
    });

    // Trigger notifications
    if (clusters.length > 0) {
      const notificationService = new NotificationService(c.env);
      runBackground(
        notificationService.triggerEvent(EVENTS.AUTH.SESSION_CREATED.code, {
          clusterId: clusters[0].id,
          userEmail: user.email,
        }, db)
      );
    }

    return c.json(createSuccessResponse({ email }, "Login successful"));
  } catch (error) {
    console.error("Verify OTP error:", error);
    return c.json(createErrorResponse({
      message: "Failed to verify code. Cross-check and try again.",
      code: ERROR.REQUEST.BAD_REQUEST.code
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }
});

// Logout
auth.get("/logout", async (c) => {
  const sessionId = getCookie(c, "session");

  if (sessionId) {
    const kv = new KVStore(getKV(c));
    await kv.deleteSession(sessionId);
  }

  const url = new URL(c.req.url);
  const hostname = url.hostname;
  const isDployrHost = hostname === "dployr.io" || hostname.endsWith(".dployr.io");

  setCookie(c, "session", "", {
    maxAge: 0,
    path: "/",
    ...(isDployrHost ? { domain: ".dployr.io" } : {}),
  });

  return c.json(createSuccessResponse({}, "Logged out successfully"));
});

export default auth;
