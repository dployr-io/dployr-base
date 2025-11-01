// routes/auth.ts
import { Hono } from "hono";
import { Bindings, Variables, OAuthProvider } from "@/types";
import { OAuthService } from "@/services/oauth";
import { KVStore } from "@/lib/kv";
import { setCookie, getCookie } from "hono/cookie";

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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

  const isValidState = await kv.validateState(state);
  if (!isValidState) {
    return c.json({ error: "Invalid state" }, 400);
  }

  try {
    const oauth = new OAuthService(c.env);

    const accessToken = await oauth.exchangeCode(provider, code);

    const user = await oauth.getUserInfo(provider, accessToken);

    let exists = await kv.getUser(user.email);
    if (!exists) {
      await kv.saveUser(user);
    }

    const sessionId = crypto.randomUUID();
    await kv.createSession(sessionId, user);

    // Set session cookie
    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
      domain: ".dployr.dev"
    });

    // Upsert user Org

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
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const user = await kv.getUser(session.email);

  let org = await kv.getOrganization(session.email)

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!org) {
    org = await kv.createOrganization({
      email: session.email,
      name: session.email.split("@")[0],
      users: [session.email],
      roles: { owner: [session.email] }
    });
  }

  return c.json({ user, org });
});

// Email authentication - Send OTP
auth.post("/login/email", async (c) => {
  try {
    const { email } = await c.req.json();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "Valid email is required" }, 400);
    }

    const kv = new KVStore(c.env.BASE_KV);
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

// Email authentication - Verify OTP
auth.post("/login/email/verify", async (c) => {
  try {
    const { email, code } = await c.req.json();

    if (!email || !code) {
      return c.json({ error: "Email and code are required" }, 400);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const isValid = await kv.validateOTP(email, code.toUpperCase());

    if (!isValid) {
      return c.json({ error: "Invalid or expired code" }, 400);
    }

    let user = await kv.getUser(email);
    if (!user) {
      user = {
        email,
        name: email.split("@")[0],
        provider: "email" as OAuthProvider,
      };
      await kv.saveUser(user);
    }

    const sessionId = crypto.randomUUID();
    await kv.createSession(sessionId, user);

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
      domain: ".dployr.dev"
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
auth.post("/logout", async (c) => {
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
