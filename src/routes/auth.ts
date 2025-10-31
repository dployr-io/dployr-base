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

  if (!["google", "apple", "microsoft"].includes(provider)) {
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

    await kv.saveUser(user);

    const sessionId = crypto.randomUUID();
    await kv.createSession(sessionId, user);

    // Set session cookie
    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
    });

    // Redirect to app
    return c.redirect(`${c.env.DPLOYR_WEB_URL}/dashboard`);
  } catch (error) {
    console.error("OAuth error:", error);
    return c.json({ error: "Authentication failed" }, 500);
  }
});

// Get current user
auth.get("/me", async (c) => {
  const session = c.get("session");

  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const user = await kv.getUser(session.userId);

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({ user });
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
