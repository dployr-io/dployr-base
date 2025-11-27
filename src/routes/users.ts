import { Hono } from "hono";
import { Bindings, Variables, User, createSuccessResponse, createErrorResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import z from "zod";
import { authMiddleware } from "@/middleware/auth";
import { ERROR } from "@/lib/constants";

const users = new Hono<{ Bindings: Bindings; Variables: Variables }>();
users.use("*", authMiddleware);

const createUserSchema = z.object({
    name: z.string().min(3).max(30).regex(/^[a-zA-Z ]+$/, "Name must contain only letters and spaces"),
    picture: z.string().min(3).max(100),
    provider: z.enum(["google", "github", "microsoft", "email"]),
    metadata: z.object(),
});

const updateUserSchema = z.object({
    name: z.string().min(3).max(30).regex(/^[a-zA-Z ]+$/, "Name must contain only letters and spaces").optional(),
    picture: z.string().min(3).max(100).optional(),
    provider: z.enum(["google", "github", "microsoft", "email"]).optional(),
    metadata: z.object().optional(),
});

// Get current user
users.get("/me", async (c) => {
    const sessionId = getCookie(c, "session");

    if (!sessionId) {
        return c.json(createErrorResponse({ 
            message: "Not authenticated", 
            code: ERROR.AUTH.BAD_SESSION.code 
        }), ERROR.AUTH.BAD_SESSION.status);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);

    const session = await kv.getSession(sessionId);

    if (!session) {
        return c.json(createErrorResponse({ 
            message: "Invalid or expired session", 
            code: ERROR.AUTH.BAD_SESSION.code 
        }), ERROR.AUTH.BAD_SESSION.status);
    }

    const user = await d1.users.get(session.email);

    if (!user) {
        return c.json(createErrorResponse({ 
            message: "User not found", 
            code: ERROR.RESOURCE.MISSING_RESOURCE.code
        }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    try {
        await d1.clusters.save(user.id);

        const clusters = await d1.clusters.listUserClusters(user.id);

        return c.json(createSuccessResponse({ user, clusters }));
    } catch (error) {
        const helpLink = "https://monitoring.dployr.dev";
        console.error(`Failed to save cluster for user ${user.id}:`, error);
        return c.json(createErrorResponse({ 
            message: "Failed to load user data", 
            code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
            helpLink 
        }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
    }
});

users.patch("/me", async (c) => {
    const sessionId = getCookie(c, "session");

    if (!sessionId) {
        return c.json(createErrorResponse({ 
            message: "Not authenticated", 
            code: ERROR.AUTH.BAD_SESSION.code 
        }), ERROR.AUTH.BAD_SESSION.status);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);

    const session = await kv.getSession(sessionId);

    if (!session) {
        return c.json(createErrorResponse({ 
            message: "Invalid or expired session", 
            code: ERROR.AUTH.BAD_SESSION.code 
        }), ERROR.AUTH.BAD_SESSION.status);
    }

    const data = await c.req.json();
    const validation = updateUserSchema.safeParse(data);
    if (!validation.success) {
        const errors = validation.error.issues.map((err) => ({
            field: err.path.join("."),
            message: err.message,
        }));

        const errorMessage = errors
            .map((e) => `${e.field}: ${e.message}`)
            .join(", ");

        return c.json(createErrorResponse({ 
            message: "Invalid request body: " + errorMessage, 
            code: ERROR.REQUEST.BAD_REQUEST.code 
        }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const updates: Partial<Omit<User, "id" | "createdAt">> = validation.data;
    const user = await d1.users.update(session.email, updates);

    if (!user) {
        return c.json(createErrorResponse({ 
            message: "User not found", 
            code: ERROR.RESOURCE.MISSING_RESOURCE.code 
        }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    return c.json(createSuccessResponse({ user }));
});

export default users;
