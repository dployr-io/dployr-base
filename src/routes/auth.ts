import { Hono } from "hono";
import { Bindings, Variables, OAuthProvider, createSuccessResponse, createErrorResponse } from "@/types";
import { OAuthService } from "@/services/oauth";
import { KVStore } from "@/lib/db/store/kv";
import { setCookie, getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import z from "zod";
import { sanitizeReturnTo } from "@/services/utils";
import { EmailService } from "@/services/email";
import { loginCodeTemplate } from "@/lib/templates/emails/verificationCode";
import { ERROR, EVENTS } from "@/lib/constants";

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
  const kv = new KVStore(c.env.BASE_KV);
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
    return c.json(createErrorResponse({
      message: "Missing code or state",
      code: ERROR.REQUEST.BAD_REQUEST.code
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);

  const redirectUrl = await kv.validateState(state);

  // If there's no redirect url in the payload we can,
  // confirm that it is a bad request
  if (!redirectUrl) {
    return c.json(createErrorResponse({
      message: "Invalid state",
      code: ERROR.REQUEST.BAD_REQUEST.code
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const oauth = new OAuthService(c.env);
    const accessToken = await oauth.exchangeCode({ provider, code });
    const oAuthUser = await oauth.getUserInfo({ provider, accessToken });

    let existingUser = await d1.users.get(oAuthUser.email);

    const userToSave = existingUser
      ? {
        email: oAuthUser.email,
        name: existingUser.name,
        provider: provider,
        metadata: oAuthUser.metadata || {},
      }
      : {
        email: oAuthUser.email,
        name: oAuthUser.name,
        picture: oAuthUser.picture,
        provider: provider,
        metadata: oAuthUser.metadata || {},
      };

    existingUser = await d1.users.save(userToSave);

    const user = existingUser;

    if (user) {
      const sessionId = crypto.randomUUID();
      const clusters = await d1.clusters.listUserClusters(user.id);
      await kv.createSession(sessionId, user, clusters);
      // Set session cookie
      setCookie(c, "session", sessionId, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        maxAge: 60 * 60 * 24 * 7, // 7 days
        path: "/",
        domain: ".dployr.dev",
      });

      await kv.logEvent({
        actor: {
          id: user.id,
          type: "user",
        },
        targets: clusters.map((cluster) => ({ id: cluster.id })),
        type: EVENTS.AUTH.SESSION_CREATED.code,
        request: c.req.raw,
      });
    }

    return c.redirect(new URL(redirectUrl, c.env.APP_URL).toString());
  } catch (error) {
    console.error("OAuth error:", error);
    return c.redirect(`${c.env.APP_URL}/?authError=${encodeURIComponent(`Failed to sign-in with ${provider}. Try email instead.`)}`);
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

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);

    let user = await d1.users.get(email);
    if (!user) {
      await d1.users.save({
        email,
        provider: "email" as OAuthProvider,
        metadata: {}
      });
    }

    const code = await kv.createOTP(email);
    const name = email.split('@')[0]
    const emailService = new EmailService({
      env: c.env,
      to: email,
    });

    await emailService.sendEmail("Verify your account", loginCodeTemplate(name, code))

    return c.json(createSuccessResponse({ email }, "OTP sent to your email"));
  } catch (error) {
    console.error("Send OTP error:", error);
    return c.redirect(`${c.env.APP_URL}/?authError=${encodeURIComponent("Failed to send code. Wait a few moments and try again.")}`);
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

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);
    const isValid = await kv.validateOTP(email, code.toUpperCase());

    if (!isValid) {
      return c.json(createErrorResponse({
        message: "Invalid or expired code",
        code: ERROR.REQUEST.INVALID_OTP.code
      }), ERROR.REQUEST.INVALID_OTP.status);
    }

    let user = await d1.users.get(email);
    if (!user) {
      return c.json(createErrorResponse({
        message: "User not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code
      }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    const sessionId = crypto.randomUUID();
    const clusters = await d1.clusters.listUserClusters(user.id);
    await kv.createSession(sessionId, user, clusters);

    await kv.logEvent({
      actor: {
        id: user.id,
        type: "user",
      },
      targets: clusters.map((cluster) => ({ id: cluster.id })),
      type: EVENTS.AUTH.SESSION_CREATED.code,
      request: c.req.raw,
    });

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
      domain: ".dployr.dev",
    });

    return c.json(createSuccessResponse({ email }, "Login successful"));
  } catch (error) {
    console.error("Verify OTP error:", error);
    return c.redirect(`${c.env.APP_URL}/?authError=${encodeURIComponent("Failed to verify code. Cross-check and try again.")}`);
  }
});

// Logout
auth.get("/logout", async (c) => {
  const sessionId = getCookie(c, "session");

  if (sessionId) {
    const kv = new KVStore(c.env.BASE_KV);
    await kv.deleteSession(sessionId);
  }

  setCookie(c, "session", "", {
    maxAge: 0,
    path: "/",
  });

  return c.json(createSuccessResponse({}, "Logged out successfully"));
});

export default auth;
