// routes/auth.ts
import { Hono } from "hono";
import { Bindings, Variables, OAuthProvider } from "@/types";
import { OAuthService } from "@/services/oauth";
import { KVStore } from "@/lib/db/store/kv";
import { setCookie, getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import z from "zod";
import { ulid } from "ulid";

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
    return c.json({ error: "Invalid provider" }, 400);
  }

  const oauth = new OAuthService(c.env);
  const kv = new KVStore(c.env.BASE_KV);

  const state = crypto.randomUUID();
  await kv.createState(state);

  const authUrl = oauth.getAuthUrl(provider, state);

  return c.redirect(authUrl);
});

// OAuth callback
auth.get("/callback/:provider", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "Missing code or state" }, 400);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);

  const isValidState = await kv.validateState(state);
  if (!isValidState) {
    return c.json({ error: "Invalid state" }, 400);
  }

  try {
    const oauth = new OAuthService(c.env);

    const accessToken = await oauth.exchangeCode(provider, code);

    const user = await oauth.getUserInfo(provider, accessToken);

    const newUser = {
      ...user,
      id: ulid(),
      provider: provider,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    
    let existingUser = await d1.users.get(user.email);
    if (!existingUser) {
      await d1.users.save(newUser);
    }

    const sessionId = crypto.randomUUID();
    const clusters = await d1.clusters.listUserClusters(newUser.id);
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

    // Redirect to app
    return c.redirect(`${c.env.WEB_URL}/dashboard`);
  } catch (error) {
    console.error("OAuth error:", error);
    return c.json({ error: "Authentication failed" }, 500);
  }
});

// Get current user
auth.get("/me", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);

  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const user = await d1.users.get(session.email);

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const cluster = await d1.clusters.create(user.id);

  return c.json({ user, cluster });
});

// Email authentication - Send OTP
auth.post("/login/email", async (c) => {
  try {
    const data = await c.req.json();
    const { email } = data;
    const validation = loginSchema.safeParse(data);
    if (!validation.success) {
      return c.json({ error: "Invalid email format" }, 400);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);

    let user = await d1.users.get(email);
    if (!user) {
      const newUser = {
        id: ulid(),
        email,
        provider: "email" as OAuthProvider,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      await d1.users.save(newUser);
    }

    const code = await kv.createOTP(email);

    // TODO: Send email with OTP code

    return c.json({
      message: "OTP sent to your email",
      success: true,
    });
  } catch (error) {
    console.error("Send OTP error:", error);
    return c.json({ error: "Failed to send code" }, 500);
  }
});

// Email with magic code - Verify OTP
auth.post("/login/email/verify", async (c) => {
  try {
    const data = await c.req.json();
    const { email, code } = data;

    const validation = otpSchema.safeParse(data);
    if (!validation.success) {
      return c.json({ error: "Invalid email or code format" }, 400);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);
    const isValid = await kv.validateOTP(email, code.toUpperCase());

    if (!isValid) {
      return c.json({ error: "Invalid or expired code" }, 400);
    }

    let user = await d1.users.get(email);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    const sessionId = crypto.randomUUID();
    const clusters = await d1.clusters.listUserClusters(user.id);
    await kv.createSession(sessionId, user, clusters);

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
      domain: ".dployr.dev",
    });

    return c.json({
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return c.json({ error: "Failed to verify OTP" }, 500);
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

  return c.json({ message: "Logged out successfully" });
});

export default auth;
