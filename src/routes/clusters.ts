import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types";
import { D1Store } from "@/lib/db/store";
import { authMiddleware, requireClusterAdmin, requireClusterOwner } from "@/middleware/auth";
import z from "zod";
import { BAD_REQUEST, INTERNAL_SERVER_ERROR, MISSING_RESOURCE } from "@/lib/constants";

const clusters = new Hono<{ Bindings: Bindings; Variables: Variables }>();
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
  const d1 = new D1Store(c.env.BASE_DB);

  const _clusters = await d1.clusters.listUserClusters(session.userId);

  return c.json(createSuccessResponse({ clusters: _clusters }));
});

/**
 * Get pending invites for current user
 */
clusters.get("/users/invites", async (c) => {
  const session = c.get("session")!;
  const d1 = new D1Store(c.env.BASE_DB);

  try {
    const clusterIds = await d1.clusters.listPendingInvites(session.userId);

    return c.json(createSuccessResponse({ invites: clusterIds }));
  } catch (error) {
    console.error("Get invites error:", error);
    return c.json(createErrorResponse({ message: "Failed to get invites", code: INTERNAL_SERVER_ERROR }), 500);
  }
});

/**
 * Accept a cluster invite
 */
clusters.get("/:id/users/invites/accept", async (c) => {
  const session = c.get("session")!;
  const d1 = new D1Store(c.env.BASE_DB);
  const clusterId = c.req.param("id");

  try {
    if (!clusterId) {
      return c.json(createErrorResponse({ message: "clusterId is required", code: MISSING_RESOURCE }), 400);
    }

    await d1.clusters.acceptInvite(session.userId, clusterId);

    return c.json(createSuccessResponse({ clusterId }, "Invite accepted"));
  } catch (error) {
    console.error("Accept invite error:", error);
    return c.json(createErrorResponse({ message: "Failed to accept invite", code: INTERNAL_SERVER_ERROR }), 500);
  }
});

/**
 * Decline a cluster invite
 */
clusters.get("/:id/users/invites/decline", async (c) => {
  const session = c.get("session")!;
  const d1 = new D1Store(c.env.BASE_DB);
  const clusterId = c.req.param("id");

  try {

    if (!clusterId) {
      return c.json(createErrorResponse({ message: "clusterId is required", code: MISSING_RESOURCE }), 400);
    }

    await d1.clusters.declineInvite(session.userId, clusterId);

    return c.json(createSuccessResponse({ clusterId }, "Invite declined"));
  } catch (error) {
    console.error("Decline invite error:", error);
    return c.json(createErrorResponse({ message: "Failed to decline invite", code: INTERNAL_SERVER_ERROR }), 500);
  }
});

/**
 * List all users in a cluster 
 */
clusters.get("/:id/users", async (c) => {
  const d1 = new D1Store(c.env.BASE_DB);

  const clusterId = c.req.param("id");

  const { page, pageSize, offset } = parsePaginationParams(
    c.req.query("page"),
    c.req.query("pageSize")
  );

  const showInvites = c.req.queries("showInvites");

  const { users, total } = showInvites ?
    await d1.clusters.listClusterInvites(clusterId, pageSize, offset) :
    await d1.clusters.listClusterUsers(clusterId, pageSize, offset);

  const paginatedData = createPaginatedResponse(users, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

/**
 * Add new users to cluster (sends invites)
 */
clusters.post("/:id/users", requireClusterAdmin, async (c) => {
  const d1 = new D1Store(c.env.BASE_DB);
  const id = c.req.param("id");
  const withdraw = c.req.query("withdraw");

  try {
    const data = await c.req.json();
    const { users } = data;
    const validation = addUsersSchema.safeParse(data);

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ message: "Validation failed " + errors, code: BAD_REQUEST }), 400);
    }

    await d1.clusters.addUsers(id, users);

    return c.json(createSuccessResponse({ users }, "Invites sent successfully"));
  } catch (error) {
    console.error("Add users error:", error);

    const helpLink = "https://monitoring.dployr.dev";

    return c.json(
      createErrorResponse({
        message: "Something went wrong while adding users",
        code: INTERNAL_SERVER_ERROR,
        helpLink
      }),
      500
    );
  }
});

/**
 * Remove users from cluster
 */
clusters.post("/:id/users/remove", requireClusterAdmin, async (c) => {
  const d1 = new D1Store(c.env.BASE_DB);

  try {
    const data = await c.req.json();
    const validation = removeUsersSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ message: "Validation failed " + errors[0].message, code: BAD_REQUEST }), 400);
    }

    const { users } = validation.data;

    await d1.clusters.removeUsers(id, users);

    return c.json(createSuccessResponse({ users }, "Users removed successfully"));
  } catch (error) {
    console.error("Update roles error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ message: "Failed to remove users", code: INTERNAL_SERVER_ERROR, helpLink }), 500);
  }
});

/**
 * Update cluster roles
 * 
 * Updates cluster users and permissions. Note that cluster ownership
 * cannot be changed through this endpoint - use the /owner endpoint instead.
 */
clusters.patch("/:id/users", requireClusterAdmin, async (c) => {
  const d1 = new D1Store(c.env.BASE_DB);

  try {
    const data = await c.req.json();
    const validation = updateRolesSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ message: "Validation failed " + errors, code: BAD_REQUEST }), 400);
    }

    const { roles } = validation.data;

    const updates = {
      owner: [], // leave empty 
      admin: roles.admin || [],
      developer: roles.developer || [],
      viewer: roles.viewer || [],
      invited: [], // leave empty
    };
    const cluster = await d1.clusters.update(id, { roles: updates });

    if (!cluster) {
      return c.json(createErrorResponse({ message: "Cluster not found", code: MISSING_RESOURCE }), 404);
    }

    return c.json(createSuccessResponse({ cluster }, "Roles updated successfully"));
  } catch (error) {
    console.error("Update roles error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ message: "Failed to update roles", code: INTERNAL_SERVER_ERROR, helpLink }), 500);
  }
});

/**
 * Transfer ownership of cluster to a new user
 */
clusters.post("/:id/users/owner", requireClusterOwner, async (c) => {
  const d1 = new D1Store(c.env.BASE_DB);

  try {
    const data = await c.req.json();
    const validation = transferOwnerSchema.safeParse(data);
    const id = c.req.param("id");

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ message: "Validation failed " + errors[0].message, code: BAD_REQUEST }), 400);
    }

    const { newOwnerId, previousOwnerRole } = validation.data;

    await d1.clusters.transferOwnership(id, newOwnerId, previousOwnerRole);

    return c.json(createSuccessResponse({ newOwnerId, previousOwnerRole }, "Ownership transferred successfully"));
  } catch (error) {
    console.error("Transfer ownership error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ message: "Failed to transfer ownership", code: INTERNAL_SERVER_ERROR, helpLink }), 500);
  }
});


export default clusters;
