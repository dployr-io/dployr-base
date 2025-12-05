// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { authMiddleware, requireClusterAdmin, requireClusterOwner } from "@/middleware/auth.js";
import z from "zod";
import { KVStore } from "@/lib/db/store/kv.js";
import { GitHubService } from "@/services/github.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { NotificationService } from "@/services/notifications.js";
import { getKV, getDB, runBackground, type AppVariables } from "@/lib/context.js";

const clusters = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();
clusters.use("*", authMiddleware);

const addUsersSchema = z.object({
  users: z.array(z.email())
});

const removeUsersSchema = z.object({
  users: z.array(z.ulid())
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
  const db = new DatabaseStore(getDB(c) as any);

  const _clusters = await db.clusters.listUserClusters(session.userId);

  return c.json(createSuccessResponse({ clusters: _clusters }));
});

/**
 * Get pending invites for current user
 */
clusters.get("/users/invites", async (c) => {
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c) as any);

  try {
    const clusterIds = await db.clusters.listPendingInvites(session.userId);

    return c.json(createSuccessResponse({ invites: clusterIds }));
  } catch (error) {
    console.error("Get invites error:", error);
    return c.json(createErrorResponse({
      message: "Failed to get invites",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

/**
 * Accept a cluster invite
 */
clusters.get("/:id/users/invites/accept", async (c) => {
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c) as any);
  const clusterId = c.req.param("id");

  try {
    if (!clusterId) {
      return c.json(createErrorResponse({
        message: "clusterId is required",
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    await db.clusters.acceptInvite(session.userId, clusterId);

    // Trigger notifications
    const notificationService = new NotificationService(c.env);
    runBackground(
      notificationService.triggerEvent(EVENTS.CLUSTER.INVITE_ACCEPTED.code, {
        clusterId,
        userEmail: session.email,
      }, db)
    );

    return c.json(createSuccessResponse({ clusterId }, "Invite accepted"));
  } catch (error) {
    console.error("Accept invite error:", error);
    return c.json(createErrorResponse({
      message: "Failed to accept invite",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

/**
 * Decline a cluster invite
 */
clusters.get("/:id/users/invites/decline", async (c) => {
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c) as any);
  const clusterId = c.req.param("id");

  try {

    if (!clusterId) {
      return c.json(createErrorResponse({
        message: "clusterId is required",
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    await db.clusters.declineInvite(session.userId, clusterId);

    return c.json(createSuccessResponse({ clusterId }, "Invite declined"));
  } catch (error) {
    console.error("Decline invite error:", error);
    return c.json(createErrorResponse({
      message: "Failed to decline invite",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

/**
 * List all users in a cluster 
 */
clusters.get("/:id/users", async (c) => {
  const db = new DatabaseStore(getDB(c) as any);

  const clusterId = c.req.param("id");

  const { page, pageSize, offset } = parsePaginationParams(
    c.req.query("page"),
    c.req.query("pageSize")
  );

  const showInvites = c.req.queries("showInvites");

  const { users, total } = showInvites ?
    await db.clusters.listClusterInvites(clusterId, pageSize, offset) :
    await db.clusters.listClusterUsers(clusterId, pageSize, offset);

  const paginatedData = createPaginatedResponse(users, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

/**
 * Add new users to cluster (sends invites)
 */
clusters.post("/:id/users", requireClusterAdmin, async (c) => {
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c) as any);
  const kv = new KVStore(getKV(c));
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
      return c.json(createErrorResponse({
        message: "Validation failed " + errors.map(e => `${e.field}: ${e.message}`).join(", "),
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

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

    return c.json(createSuccessResponse({ users }, "Invites sent successfully"));
  } catch (error) {
    console.error("Add users error:", error);

    const helpLink = "https://monitoring.dployr.dev";

    return c.json(
      createErrorResponse({
        message: "Something went wrong while adding users",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        helpLink
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status
    );
  }
});

/**
 * Remove users from cluster
 */
clusters.post("/:id/users/remove", requireClusterAdmin, async (c) => {
  const session = c.get("session")!;
  const db = new DatabaseStore(getDB(c) as any);
  const kv = new KVStore(getKV(c));

  try {
    const data = await c.req.json();
    const validation = removeUsersSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({
        message: "Validation failed " + errors.map(e => `${e.field}: ${e.message}`).join(", "),
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { users } = validation.data;

    await db.clusters.removeUsers(id, users);

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

    return c.json(createSuccessResponse({ users }, "Users removed successfully"));
  } catch (error) {
    console.error("Update roles error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({
      message: "Failed to remove users",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
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
  const db = new DatabaseStore(getDB(c) as any);
  const kv = new KVStore(getKV(c));

  try {
    const data = await c.req.json();
    const validation = updateRolesSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({
        message: "Validation failed " + errors.map(e => `${e.field}: ${e.message}`).join(", "),
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { roles } = validation.data;

    const updates = {
      owner: [], // leave empty 
      admin: roles.admin || [],
      developer: roles.developer || [],
      viewer: roles.viewer || [],
      invited: [], // leave empty
    };
    const cluster = await db.clusters.update(id, { roles: updates });

    if (!cluster) {
      return c.json(createErrorResponse({
        message: "Cluster not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code
      }), ERROR.RESOURCE.MISSING_RESOURCE.status);
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
      type: EVENTS.PERMISSION.ADMIN_ACCESS_GRANTED.code,
      request: c.req.raw,
    });

    return c.json(createSuccessResponse({ cluster }, "Roles updated successfully"));
  } catch (error) {
    console.error("Update roles error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({
      message: "Failed to update roles",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

/**
 * Transfer ownership of cluster to a new user
 */
clusters.post("/:id/users/owner", requireClusterOwner, async (c) => {
  const db = new DatabaseStore(getDB(c) as any);

  try {
    const data = await c.req.json();
    const validation = transferOwnerSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({
        message: "Validation failed " + errors.map(e => `${e.field}: ${e.message}`).join(", "),
        code: ERROR.REQUEST.BAD_REQUEST.code
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { newOwnerId, previousOwnerRole } = validation.data;

    await db.clusters.transferOwnership(id, newOwnerId, previousOwnerRole);

    return c.json(createSuccessResponse({ newOwnerId, previousOwnerRole }, "Ownership transferred successfully"));
  } catch (error) {
    console.error("Transfer ownership error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({
      message: "Failed to transfer ownership",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

/**
 * List available connected integrations 
 */
clusters.get("/:id/integrations", async (c) => {
  const db = new DatabaseStore(getDB(c) as any);
  const clusterId = c.req.param("id");

  try {
    let integrations = await db.clusters.listClusterIntegrations(clusterId);
    const gitHub = new GitHubService(c.env)
    const installationId = integrations.remote.gitHub?.installationId
    let remoteCount = 0

    if (installationId) {
      remoteCount = await gitHub.remoteCount({ installationId });
    }

    if (integrations.remote.gitHub) {
      integrations.remote.gitHub.remotesCount = remoteCount;
      integrations.remote.gitHub.installUrl = "https://github.com/apps/dployr-io";
    }

    return c.json(createSuccessResponse(integrations));
  } catch (error) {
    console.error("List remotes error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({
      message: "Failed to list remotes",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

/** 
 * List available GitHub repositories 
 * This list reposistories that are accessible to the GitHub installation
 */
clusters.get("/:id/remotes", async (c) => {
  const clusterId = c.req.param("id");
  const db = new DatabaseStore(getDB(c) as any);

  try {
    const gitHub = new GitHubService(c.env);
    const integrations = await db.clusters.listClusterIntegrations(clusterId);
    const remotes = await gitHub.listRemotes({ installationId: integrations.remote.gitHub?.installationId });
    const { page, pageSize, offset } = parsePaginationParams(
      c.req.query("page"),
      c.req.query("pageSize")
    );

    const total = remotes.length;
    const paginatedRemotes = remotes.slice(offset, offset + pageSize);
    const paginatedData = createPaginatedResponse(paginatedRemotes, page, pageSize, total);

    return c.json(createSuccessResponse(paginatedData));
  } catch (error) {
    console.error("List remotes error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({
      message: "Failed to list remotes",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});


export default clusters;
