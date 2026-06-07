// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { authMiddleware, requireClusterViewer, requireClusterAdmin, requireClusterOwner } from "@/middleware/auth.js";
import z from "zod";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { getKVStore, getGitHubService, getDbStore } from "@/lib/config/context.js";
import { worker } from "@/services/background/index.js";
import { notify } from "@/services/background/jobs/notify.js";
import { ResourceNotFoundError, ValidationError } from "@/lib/errors/errors.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Clusters");

const clusters = new Hono<{ Bindings: Bindings; Variables: Variables }>();
clusters.use("*", authMiddleware);

const notificationsUpsertSchema = z.object({
  enabled: z.boolean(),
  slackWebhookUrl: z.url().nullish(),
  discordWebhookUrl: z.url().nullish(),
});

const renameClusterSchema = z.object({
  name: z.string().min(1).max(64),
});

const addUsersSchema = z.object({
  users: z.array(z.email()),
});

const removeUsersSchema = z.object({
  users: z.array(z.ulid()),
});

const transferOwnerSchema = z.object({
  newOwnerId: z.ulid(),
  previousOwnerRole: z.enum(["admin", "developer", "viewer"]).default("viewer"),
});

const updateRolesSchema = z.object({
  roles: z.object({
    admin: z.array(z.email()).optional(),
    developer: z.array(z.email()).optional(),
    viewer: z.array(z.email()).optional(),
  }),
});

/**
 * List all clusters
 */
clusters.get("/", async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);

  const _clusters = await db.clusters.listUserClusters(session.userId);

  return c.json(createSuccessResponse({ clusters: _clusters }));
});

/**
 * Get pending invites for current user
 */
clusters.get("/users/invites", async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);

  try {
    const clusterIds = await db.clusters.listPendingInvites(session.userId);

    return c.json(createSuccessResponse({ invites: clusterIds }));
  } catch (error) {
    log.error("Get invites error:", error);
    return c.json(
      createErrorResponse({
        message: "Failed to get invites",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * Accept a cluster invite
 */
clusters.get("/:id/users/invites/accept", async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);
  const kv = getKVStore(c);
  const clusterId = c.req.param("id");

  try {
    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "clusterId is required",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    await db.clusters.acceptInvite(session.userId, clusterId);

    const sessionId = await kv.getSessionIdByUserId(session.userId);
    if (sessionId) {
      const clusters = await db.clusters.listUserClusters(session.userId);
      await kv.refreshSession({ sessionId, updates: { clusters } });
    }

    const cluster = await db.clusters.get(clusterId);

    // Trigger notifications
    worker.dispatch(notify(EVENTS.CLUSTER.INVITE_ACCEPTED.code, { clusterId, clusterName: cluster?.name, userEmail: session.email }));

    return c.json(createSuccessResponse({ clusterId }, "Invite accepted"));
  } catch (error) {
    log.error("Accept invite error:", error);
    if (error instanceof ResourceNotFoundError) {
      return c.json(
        createErrorResponse({
          message: error.message,
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }
    return c.json(
      createErrorResponse({
        message: "Failed to accept invite",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * Decline a cluster invite
 */
clusters.get("/:id/users/invites/decline", async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);
  const kv = getKVStore(c);
  const clusterId = c.req.param("id");

  try {
    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "clusterId is required",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    await db.clusters.declineInvite(session.userId, clusterId);

    const sessionId = await kv.getSessionIdByUserId(session.userId);
    if (sessionId) {
      const clusters = await db.clusters.listUserClusters(session.userId);
      await kv.refreshSession({ sessionId, updates: { clusters } });
    }

    return c.json(createSuccessResponse({ clusterId }, "Invite declined"));
  } catch (error) {
    log.error("Decline invite error:", error);
    if (error instanceof ResourceNotFoundError) {
      return c.json(
        createErrorResponse({
          message: error.message,
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }
    return c.json(
      createErrorResponse({
        message: "Failed to decline invite",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * List all users in a cluster
 */
clusters.get("/:id/users", requireClusterViewer, async (c) => {
  const db = getDbStore(c);

  const clusterId = c.req.param("id");

  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));

  const showInvites = c.req.queries("showInvites");

  const { users, total } = await db.clusters.listUsers(clusterId, { invited: !!showInvites, limit: pageSize, offset });

  const paginatedData = createPaginatedResponse(users, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

/**
 * Add new users to cluster (sends invites)
 */
clusters.post("/:id/users", requireClusterAdmin, async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);
  const kv = getKVStore(c);
  const id = c.req.param("id");

  try {
    const data = await c.req.json();
    const { users }: { users: string[] } = data;
    const validation = addUsersSchema.safeParse(data);

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(
        createErrorResponse({
          message: "Validation failed " + errors.map((e) => `${e.field}: ${e.message}`).join(", "),
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    const cluster = await db.clusters.get(id);

    await db.clusters.addUsers(id, users);

    await kv.logEvent({
      actor: {
        id: session.userId,
        type: "user",
      },
      targets: [
        {
          id,
        },
      ],
      type: EVENTS.CLUSTER.USER_INVITED.code,
      request: c.req.raw,
    });

    for (const userEmail of users) {
      worker.dispatch(notify(EVENTS.CLUSTER.USER_INVITED.code, { clusterId: id, clusterName: cluster?.name, userEmail, to: userEmail }));
    }

    return c.json(createSuccessResponse({ users }, "Invites sent successfully"));
  } catch (error) {
    log.error("Add users error:", error);

    const helpLink = "https://monitoring.dployr.io";

    return c.json(
      createErrorResponse({
        message: "Something went wrong while adding users",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * Remove users from cluster
 */
clusters.post("/:id/users/remove", requireClusterAdmin, async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);
  const kv = getKVStore(c);

  try {
    const data = await c.req.json();
    const validation = removeUsersSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(
        createErrorResponse({
          message: "Validation failed " + errors.map((e) => `${e.field}: ${e.message}`).join(", "),
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    const { users } = validation.data;

    const removedUserRecords = await Promise.all(users.map((userId) => db.users.find({ id: userId })));

    await db.clusters.removeUsers(id, users);

    for (const userId of users) {
      const sessionId = await kv.getSessionIdByUserId(userId);
      if (sessionId) {
        await kv.refreshSession({ sessionId, updates: { clusters: await db.clusters.listUserClusters(userId) } });
      }
    }

    const cluster = await db.clusters.get(id);

    await kv.logEvent({
      actor: {
        id: session.userId,
        type: "user",
      },
      targets: [
        {
          id,
        },
      ],
      type: EVENTS.CLUSTER.REMOVED_USER.code,
      request: c.req.raw,
    });

    for (const user of removedUserRecords) {
      if (user?.email) {
        worker.dispatch(notify(EVENTS.CLUSTER.REMOVED_USER.code, { clusterId: id, clusterName: cluster?.name, userEmail: user.email, to: user.email }));
      }
    }

    return c.json(createSuccessResponse({ users }, "Users removed successfully"));
  } catch (error) {
    log.error("Remove users error:", error);
    if (error instanceof ValidationError) {
      return c.json(
        createErrorResponse({
          message: error.message,
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }
    const helpLink = "https://monitoring.dployr.io";
    return c.json(
      createErrorResponse({
        message: "Failed to remove users",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * Update cluster roles
 *
 * Updates cluster users and permissions. Note that cluster ownership
 * cannot be changed through this endpoint - use the /owner endpoint instead.
 */
clusters.patch("/:id/users", requireClusterAdmin, async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);
  const kv = getKVStore(c);

  try {
    const data = await c.req.json();
    const validation = updateRolesSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(
        createErrorResponse({
          message: "Validation failed " + errors.map((e) => `${e.field}: ${e.message}`).join(", "),
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    const { roles } = validation.data;

    const { users: currentUsers } = await db.clusters.listUsers(id, { invited: false });
    const emailToOldRole = new Map(currentUsers.map((u) => [u.email, u.role]));

    const updates = {
      owner: [], // leave empty
      admin: roles.admin || [],
      developer: roles.developer || [],
      viewer: roles.viewer || [],
      invited: [], // leave empty
    };
    const cluster = await db.clusters.update(id, { roles: updates });

    if (!cluster) {
      return c.json(
        createErrorResponse({
          message: "Cluster not found",
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }

    await kv.logEvent({
      actor: {
        id: session.userId,
        type: "user",
      },
      targets: [
        {
          id,
        },
      ],
      type: EVENTS.CLUSTER.USER_ROLE_CHANGED.code,
      request: c.req.raw,
    });

    for (const [newRole, emails] of Object.entries(roles) as [string, string[]][]) {
      for (const email of emails ?? []) {
        const oldRole = emailToOldRole.get(email);
        if (oldRole && oldRole !== newRole) {
          worker.dispatch(notify(EVENTS.CLUSTER.USER_ROLE_CHANGED.code, { clusterId: id, clusterName: cluster?.name, userEmail: email, oldRole, newRole, to: email }));
        }
      }
    }

    return c.json(createSuccessResponse({ cluster }, "Roles updated successfully"));
  } catch (error) {
    log.error("Update roles error:", error);
    if (error instanceof ValidationError) {
      return c.json(
        createErrorResponse({
          message: error.message,
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }
    const helpLink = "https://monitoring.dployr.io";
    return c.json(
      createErrorResponse({
        message: "Failed to update roles",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * Transfer ownership of cluster to a new user
 */
clusters.post("/:id/users/owner", requireClusterOwner, async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);
  const kv = getKVStore(c);

  try {
    const data = await c.req.json();
    const validation = transferOwnerSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(
        createErrorResponse({
          message: "Validation failed " + errors.map((e) => `${e.field}: ${e.message}`).join(", "),
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    const { newOwnerId, previousOwnerRole } = validation.data;

    const previousOwnerId = await db.clusters.getOwner(id);

    await db.clusters.transferOwnership(id, newOwnerId, previousOwnerRole);

    if (previousOwnerId) {
      const sessionId = await kv.getSessionIdByUserId(previousOwnerId);
      if (sessionId) {
        await kv.refreshSession({ sessionId, updates: { clusters: await db.clusters.listUserClusters(previousOwnerId) } });
      }
    }

    const newSessionId = await kv.getSessionIdByUserId(newOwnerId);
    if (newSessionId) {
      await kv.refreshSession({ sessionId: newSessionId, updates: { clusters: await db.clusters.listUserClusters(newOwnerId) } });
    }

    const [previousOwnerUser, newOwnerUser, cluster] = await Promise.all([
      previousOwnerId ? db.users.find({ id: previousOwnerId }) : Promise.resolve(null),
      db.users.find({ id: newOwnerId }),
      db.clusters.get(id),
    ]);

    await kv.logEvent({
      actor: { id: session.userId, type: "user" },
      targets: [{ id }],
      type: EVENTS.CLUSTER.OWNERSHIP_TRANSFERRED.code,
      request: c.req.raw,
    });

    if (newOwnerUser?.email) {
      const payload = {
        clusterId: id,
        clusterName: cluster?.name,
        newOwner: newOwnerUser.email,
        previousOwner: previousOwnerUser?.email ?? session.email,
      };
      worker.dispatch(notify(EVENTS.CLUSTER.OWNERSHIP_TRANSFERRED.code, { ...payload, userEmail: newOwnerUser.email, to: newOwnerUser.email }));
      if (previousOwnerUser?.email) {
        worker.dispatch(notify(EVENTS.CLUSTER.OWNERSHIP_TRANSFERRED.code, { ...payload, userEmail: previousOwnerUser.email, to: previousOwnerUser.email }));
      }
    }

    return c.json(createSuccessResponse({ newOwnerId, previousOwnerRole }, "Ownership transferred successfully"));
  } catch (error) {
    log.error("Transfer ownership error:", error);
    const helpLink = "https://monitoring.dployr.io";
    return c.json(
      createErrorResponse({
        message: "Failed to transfer ownership",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * List available connected integrations
 */
clusters.get("/:id/integrations", requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.req.param("id");

  try {
    let integrations = await db.clusters.listClusterIntegrations(clusterId);
    const gitHub = getGitHubService(c);
    const installationId = integrations.remote.gitHub?.installationId;
    let remoteCount = 0;

    if (installationId) {
      remoteCount = await gitHub.remoteCount({ installationId });
    }

    if (integrations.remote.gitHub) {
      integrations.remote.gitHub.remotesCount = remoteCount;
      integrations.remote.gitHub.installUrl = "https://github.com/apps/dployr-io";
    }

    return c.json(createSuccessResponse(integrations));
  } catch (error) {
    log.error("List remotes error:", error);
    const helpLink = "https://monitoring.dployr.io";
    return c.json(
      createErrorResponse({
        message: "Failed to list remotes",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * List available GitHub repositories
 * This list reposistories that are accessible to the GitHub installation
 */
clusters.get("/:id/remotes", requireClusterViewer, async (c) => {
  const clusterId = c.req.param("id");
  const db = getDbStore(c);

  try {
    const gitHub = getGitHubService(c);
    const integrations = await db.clusters.listClusterIntegrations(clusterId);
    const remotes = await gitHub.listRemotes({ installationId: integrations.remote.gitHub?.installationId });
    const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));

    const total = remotes.length;
    const paginatedRemotes = remotes.slice(offset, offset + pageSize);
    const paginatedData = createPaginatedResponse(paginatedRemotes, page, pageSize, total);

    return c.json(createSuccessResponse(paginatedData));
  } catch (error) {
    log.error("List remotes error:", error);
    const helpLink = "https://monitoring.dployr.io";
    return c.json(
      createErrorResponse({
        message: "Failed to list remotes",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * Rename a cluster (owner only).
 * Limited to 3 renames per rolling 12-month window.
 * Admins can unlock a cluster by calling kv.clearRenameHistory(clusterId).
 */
clusters.patch("/:id", requireClusterOwner, async (c) => {
  const db = getDbStore(c);
  const kv = getKVStore(c);
  const clusterId = c.req.param("id");

  const data = await c.req.json().catch(() => null);
  const validation = renameClusterSchema.safeParse(data);

  if (!validation.success) {
    return c.json(
      createErrorResponse({ message: "Validation failed: name must be a non-empty string (max 64 chars)", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { name } = validation.data;

  const block = await kv.recordRename(clusterId);
  if (block) {
    const { oldestAt, lastRenameAt } = await kv.getRenameQuota(clusterId);
    const fmt = (ts: number, offsetMs: number) =>
      new Date(ts + offsetMs).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

    const message =
      block === "monthly_cooldown"
        ? `You can only rename once per month. Try again after ${lastRenameAt ? fmt(lastRenameAt, 30 * 24 * 60 * 60 * 1000) : "30 days"}.`
        : `You've used all 3 renames for this year. Try again after ${oldestAt ? fmt(oldestAt, 365 * 24 * 60 * 60 * 1000) : "12 months"}.`;

    return c.json(
      createErrorResponse({ message, code: ERROR.REQUEST.TOO_MANY_REQUESTS.code }),
      ERROR.REQUEST.TOO_MANY_REQUESTS.status,
    );
  }

  try {
    const cluster = await db.clusters.update(clusterId, { name });
    log.info(`Cluster "${cluster?.name}" renamed`);

    // Refresh sessions for all cluster members so their cached cluster name is up to date.
    const { users } = await db.clusters.listUsers(clusterId, { invited: false });
    await Promise.all(
      users.map(async (user) => {
        const sessionId = await kv.getSessionIdByUserId(user.id);
        if (sessionId) {
          const clusters = await db.clusters.listUserClusters(user.id);
          await kv.refreshSession({ sessionId, updates: { clusters } });
        }
      }),
    );

    return c.json(createSuccessResponse({ cluster }, "Cluster renamed successfully"));
  } catch (error) {
    log.error("Rename cluster error:", error);
    return c.json(
      createErrorResponse({ message: "Failed to rename cluster", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// ── Notifications ─────────────────────────────────────────────────────────────

/**
 * Get notification config for a cluster
 */
clusters.get("/:id/notifications", requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.req.param("id");

  const config = await db.notifications.get(clusterId);
  // Return a default-shaped object if no row exists yet (enabled=true, no webhooks)
  return c.json(createSuccessResponse({ notifications: config ?? { clusterId, enabled: true, slackWebhookUrl: null, discordWebhookUrl: null } }));
});

/**
 * Upsert notification config for a cluster
 */
clusters.put("/:id/notifications", requireClusterAdmin, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.req.param("id");

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json(createErrorResponse({ message: "Request body is required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const parsed = notificationsUpsertSchema.safeParse(body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }));
    return c.json(
      createErrorResponse({ message: "Validation failed: " + errors.map((e) => `${e.field}: ${e.message}`).join(", "), code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { enabled, slackWebhookUrl, discordWebhookUrl } = parsed.data;

  try {
    const config = await db.notifications.upsert({ clusterId, enabled, slackWebhookUrl, discordWebhookUrl });
    return c.json(createSuccessResponse({ notifications: config }));
  } catch (error) {
    log.error("Upsert notifications error:", error);
    return c.json(
      createErrorResponse({ message: "Failed to save notification config", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

export default clusters;
