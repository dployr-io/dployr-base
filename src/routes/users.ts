import { Hono } from "hono";
import { Bindings, Variables, OAuthProvider, User, createSuccessResponse, createErrorResponse } from "@/types";
import { OAuthService } from "@/services/oauth";
import { KVStore } from "@/lib/db/store/kv";
import { setCookie, getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import z from "zod";
import { BAD_OAUTH_STATE, BAD_REQUEST, BAD_SESSION, INTERNAL_SERVER_ERROR, INVALID_OAUTH_PROVIDER, MISSING_PARAMS, MISSING_RESOURCE } from "@/lib/constants";
import { authMiddleware } from "@/middleware/auth";

const users = new Hono<{ Bindings: Bindings; Variables: Variables }>();
users.use("*", authMiddleware);

const userSchema = z.object({
    name: z.string().min(3).max(30).regex(/^[a-zA-Z]+$/, "Name must contain only alphabets"),
    picture: z.string().min(3).max(100),
    provider: z.enum(["google", "github", "microsoft", "email"]),
    metadata: z.object(),
});

// Get current user
users.get("/me", async (c) => {
    const sessionId = getCookie(c, "session");

    if (!sessionId) {
        return c.json(createErrorResponse({ message: "Not authenticated", code: BAD_SESSION }), 401);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);

    const session = await kv.getSession(sessionId);

    if (!session) {
        return c.json(createErrorResponse({ message: "Invalid or expired session", code: BAD_SESSION }), 401);
    }

    const user = await d1.users.get(session.email);

    if (!user) {
        return c.json(createErrorResponse({ message: "User not found", code: MISSING_RESOURCE }), 404);
    }

    try {
        const cluster = await d1.clusters.save(user.id);
        return c.json(createSuccessResponse({ user, cluster }));
    } catch (error) {
        const helpLink = "https://monitoring.dployr.dev";
        console.error(`Failed to save cluster for user ${user.id}:`, error);
        return c.json(createErrorResponse({ message: "Failed to load user data", code: INTERNAL_SERVER_ERROR, helpLink }), 500);
    }
});

users.patch("/me", async (c) => {
    const sessionId = getCookie(c, "session");

    if (!sessionId) {
        return c.json(createErrorResponse({ message: "Not authenticated", code: BAD_SESSION }), 401);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);

    const session = await kv.getSession(sessionId);

    if (!session) {
        return c.json(createErrorResponse({ message: "Invalid or expired session", code: BAD_SESSION }), 401);
    }

    const data = await c.req.json();
    const validation = userSchema.safeParse(data);
    if (!validation.success) {
        const errors = validation.error.issues.map((err) => ({
            field: err.path.join("."),
            message: err.message,
        }));
        return c.json(createErrorResponse({ message: "Invalid email format " + errors, code: BAD_REQUEST }), 400);
    }

    const updates: Partial<Omit<User, "id" | "createdAt">> = await c.req.json();
    const user = await d1.users.update(session.email, updates);

    if (!user) {
        return c.json(createErrorResponse({ message: "User not found", code: MISSING_RESOURCE }), 404);
    }

    return c.json(createSuccessResponse({ user }));
});

export default users;
