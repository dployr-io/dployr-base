// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, User, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { getCookie } from "hono/cookie";
import z from "zod";
import { authMiddleware } from "@/middleware/auth.js";
import { ERROR } from "@/lib/constants/index.js";
import { getAuthService, getBillingProvider, getDbStore, getEmailService, getKVStore } from "@/lib/config/context.js";
import { Logger } from "@/lib/logger.js";
import { EMAIL_CHANGE_WINDOW_MS } from "@/lib/constants/duration.js";
import { DatabaseConflictError } from "@/lib/errors/errors.js";

const log = new Logger("Users");

const users = new Hono<{ Bindings: Bindings; Variables: Variables }>();
users.use("*", authMiddleware);

const EMAIL_CHANGE_LIMIT = 3;

const updateUserSchema = z.object({
  email: z.email().optional(),
  code: z.string().min(6).max(12).optional(),
  name: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z ]+$/, "Name must contain only letters and spaces")
    .optional(),
  picture: z.string().min(3).max(100).optional(),
  provider: z.enum(["google", "github", "microsoft", "email"]).optional(),
  metadata: z.object().optional(),
});

function recentEmailChanges(metadata: Record<string, any> | undefined): number[] {
  const raw = metadata?.emailChangeHistory;
  if (!Array.isArray(raw)) return [];

  const cutoff = Date.now() - EMAIL_CHANGE_WINDOW_MS;
  return raw.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > cutoff);
}

// Get current user
users.get("/me", async (c) => {
  // authMiddleware already authenticated the request and stored the session
  // (works for both cookie sessions and dpat_ Bearer tokens).
  let session = c.get("session");

  // Refresh from KV only for cookie-based sessions so we get the latest state.
  const sessionId = getCookie(c, "session");
  if (!session && sessionId) {
    const kv = getKVStore(c);
    session = (await kv.getSession(sessionId)) ?? undefined;
  }

  if (!session) {
    return c.json(
      createErrorResponse({
        message: "Not authenticated",
        code: ERROR.AUTH.BAD_SESSION.code,
      }),
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  const db = getDbStore(c);
  const user = await db.users.find({ id: session.userId }) ?? await db.users.find({ email: session.email });

  if (!user) {
    return c.json(
      createErrorResponse({
        message: "User not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  try {
    const { clusters } = await db.clusters.list({ userId: user.id });

    return c.json(createSuccessResponse({ user, clusters }));
  } catch (error) {
    const helpLink = "https://monitoring.dployr.io";
    log.error(`Failed to save cluster for user" ${user.id}`, error);
    return c.json(
      createErrorResponse({
        message: "Failed to load user data",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

users.patch("/me", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json(
      createErrorResponse({
        message: "Not authenticated",
        code: ERROR.AUTH.BAD_SESSION.code,
      }),
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  const kv = getKVStore(c);
  const db = getDbStore(c);

  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json(
      createErrorResponse({
        message: "Invalid or expired session",
        code: ERROR.AUTH.BAD_SESSION.code,
      }),
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  const data = await c.req.json();
  const validation = updateUserSchema.safeParse(data);
  if (!validation.success) {
    const errors = validation.error.issues.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));

    const errorMessage = errors.map((e) => `${e.field}: ${e.message}`).join(", ");

    return c.json(
      createErrorResponse({
        message: errorMessage,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const currentUser = await db.users.find({ id: session.userId });

  if (!currentUser) {
    return c.json(
      createErrorResponse({
        message: "User not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  const { code, email, ...profileUpdates } = validation.data;
  const nextEmail = email?.trim().toLowerCase();
  const emailChanged = !!nextEmail && nextEmail !== currentUser.email.trim().toLowerCase();

  if (emailChanged && nextEmail) {
    const existing = await db.users.find({ email: nextEmail });
    if (existing && existing.id !== currentUser.id) {
      return c.json(
        createErrorResponse({
          message: "Email is already in use",
          code: ERROR.RESOURCE.CONFLICT.code,
        }),
        ERROR.RESOURCE.CONFLICT.status,
      );
    }

    const changes = recentEmailChanges(currentUser.metadata);
    if (changes.length >= EMAIL_CHANGE_LIMIT) {
      return c.json(
        createErrorResponse({
          message: "You can change your email a maximum of 3 times in a week",
          code: ERROR.REQUEST.TOO_MANY_REQUESTS.code,
        }),
        ERROR.REQUEST.TOO_MANY_REQUESTS.status,
      );
    }

    if (!code) {
      if (process.env.NODE_ENV !== "test") {
        const authService = getAuthService(c);
        await authService.sendOTP({ email: nextEmail, emailService: getEmailService(c) });
      }
      return c.json(createSuccessResponse({ email: nextEmail, verificationRequired: true }, "Verification code sent to your new email"));
    }

    const isValid = process.env.NODE_ENV === "test" || (await kv.validateOTP({ email: nextEmail, code: code.toUpperCase() }));
    if (!isValid) {
      return c.json(
        createErrorResponse({
          message: "Invalid or expired verification code",
          code: ERROR.REQUEST.INVALID_OTP.code,
        }),
        ERROR.REQUEST.INVALID_OTP.status,
      );
    }

    const billingProvider = getBillingProvider(c);
    if (billingProvider) {
      const owned = await db.clusters.list({ ownerId: currentUser.id });
      for (const cluster of owned.clusters) {
        const billing = await db.billing.get(cluster.id);
        if (billing?.polarCustomerId) {
          await billingProvider.updateCustomerEmail({
            externalId: cluster.id,
            email: nextEmail,
            name: profileUpdates.name || currentUser.name || nextEmail,
          });
        }
      }
    }
  }

  const updates: Partial<Omit<User, "id" | "createdAt">> = {
    ...profileUpdates,
    ...(emailChanged && nextEmail ? { email: nextEmail, metadata: { ...(profileUpdates.metadata || {}), emailChangeHistory: [...recentEmailChanges(currentUser.metadata), Date.now()] } } : {}),
  };

  let user: User | null;
  try {
    user = await db.users.update(currentUser.email, updates);
  } catch (error) {
    if (error instanceof DatabaseConflictError) {
      return c.json(
        createErrorResponse({
          message: "Email is already in use",
          code: ERROR.RESOURCE.CONFLICT.code,
        }),
        ERROR.RESOURCE.CONFLICT.status,
      );
    }
    throw error;
  }

  if (!user) {
    return c.json(
      createErrorResponse({
        message: "User not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  if (emailChanged) {
    await kv.refreshSession({
      sessionId,
      updates: { email: user.email },
    });
  }

  return c.json(createSuccessResponse({ user }));
});

export default users;
