// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Cluster, OAuthProvider, Role as UserRole, User, Integrations, GitHubIntegration } from "@/types/index.js";
import { BaseStore, Pagination } from "./base.js";
import { EVENTS, type AllowedTable } from "@/lib/constants/index.js";
import type { PreparedStatement } from "@/lib/db/pg-adapter.js";
import { ResourceNotFoundError, ValidationError } from "@/lib/errors/errors.js";

export type ClusterFilter = {
  id?: string;
  name?: string;
  instanceTag?: string;
  userId?: string;
  ownerId?: string;
  instanceId?: string;
};

export class ClusterStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "clusters";
  private readonly ROLE_HIERARCHY: Record<UserRole, number> = {
    invited: 0,
    viewer: 1,
    developer: 2,
    admin: 3,
    owner: 4,
  };

  /**
   * Find a single cluster matching the provided filter.
   *
   * @param filter - Filter criteria
   * @param filter.id - Cluster ID (exact match)
   * @param filter.name - Cluster name (case-insensitive match)
   * @param filter.userId - User ID that is an active member of the cluster (excludes invited users)
   * @param filter.ownerId - User ID that owns the cluster
   * @param filter.instanceTag - Tag of the pool instance assigned to the cluster
   * @param filter.instanceId - Instance ID associated with the cluster
   * @returns The cluster with full user roles, or null if not found
   */
  async find(filter: ClusterFilter): Promise<Cluster | null> {
    const parts: string[] = [];
    const joins: string[] = [];
    const bindings: any[] = [];

    if (filter.id !== undefined) {
      bindings.push(filter.id);
      parts.push(`c.id = $${bindings.length}`);
    }
    if (filter.name !== undefined) {
      bindings.push(filter.name);
      parts.push(`LOWER(c.name) = LOWER($${bindings.length})`);
    }
    if (filter.instanceTag !== undefined) {
      joins.push(`JOIN instances i ON c.pool_instance_id = i.id`);
      bindings.push(filter.instanceTag);
      parts.push(`i.tag = $${bindings.length}`);
    }
    if (filter.userId !== undefined) {
      joins.push(`JOIN user_clusters uc ON uc.cluster_id = c.id AND uc.role != 'invited'`);
      bindings.push(filter.userId);
      parts.push(`uc.user_id = $${bindings.length}`);
    }
    if (filter.ownerId !== undefined) {
      joins.push(`JOIN user_clusters owner_uc ON owner_uc.cluster_id = c.id AND owner_uc.role = 'owner'`);
      bindings.push(filter.ownerId);
      parts.push(`owner_uc.user_id = $${bindings.length}`);
    }
    if (filter.instanceId !== undefined) {
      joins.push(`JOIN instances inst ON inst.cluster_id = c.id`);
      bindings.push(filter.instanceId);
      parts.push(`inst.id = $${bindings.length}`);
    }

    if (!bindings.length) return null;

    let sql = `SELECT c.id, c.name, c.metadata, c.pool_instance_id, c.created_at, c.updated_at FROM clusters c`;
    if (joins.length) {
      sql += ` ${joins.join(" ")}`;
    }
    sql += ` WHERE ${parts.join(" AND ")} LIMIT 1`;

    const cluster = await this.db.prepare(sql).bind(...bindings).first();
    if (!cluster) return null;

    const usersStmt = this.db.prepare(`
      SELECT user_id, role FROM user_clusters WHERE cluster_id = $1
    `);

    const userRoles = await usersStmt.bind(cluster.id as string).all();
    const users: string[] = [];
    const roles: Record<UserRole, string[]> = {
      owner: [],
      admin: [],
      developer: [],
      viewer: [],
      invited: [],
    };

    for (const userRole of userRoles.results) {
      const userId = userRole.user_id as string;
      const role = userRole.role as UserRole;

      if (!users.includes(userId)) {
        users.push(userId);
      }

      if (!roles[role]) {
        roles[role] = [];
      }
      roles[role].push(userId);
    }

    return {
      id: cluster.id as string,
      name: cluster.name as string,
      users,
      roles,
      poolInstanceId: (cluster.pool_instance_id as string) ?? null,
      metadata: (cluster as any).metadata || {},
      createdAt: Number(cluster.created_at),
      updatedAt: Number(cluster.updated_at),
    };
  }

  /**
   * List clusters with optional filtering and pagination.
   *
   * @param filter - Optional filter and pagination criteria
   * @param filter.id - Cluster ID (exact match)
   * @param filter.name - Cluster name (case-insensitive match)
   * @param filter.userId - User ID that is an active member of the clusters (excludes invited users)
   * @param filter.ownerId - User ID that owns the clusters
   * @param filter.instanceTag - Tag of the pool instance assigned to the cluster
   * @param filter.instanceId - Instance ID associated with the clusters
   * @param filter.limit - Maximum number of results to return
   * @param filter.offset - Number of results to skip (for pagination)
   * @returns Object containing array of clusters and total count (before pagination)
   */
  async list(filter?: ClusterFilter & Pagination): Promise<{ clusters: Cluster[]; total: number }> {
    const parts: string[] = [];
    const joins: string[] = [];
    const bindings: any[] = [];

    if (filter?.id !== undefined) {
      bindings.push(filter.id);
      parts.push(`c.id = $${bindings.length}`);
    }
    if (filter?.name !== undefined) {
      bindings.push(filter.name);
      parts.push(`LOWER(c.name) = LOWER($${bindings.length})`);
    }
    if (filter?.instanceTag !== undefined) {
      bindings.push(filter.instanceTag);
      const tagParam = `$${bindings.length}`;
      parts.push(`(c.id = (SELECT cluster_id FROM instances WHERE tag = ${tagParam}) OR c.pool_instance_id = (SELECT id FROM instances WHERE tag = ${tagParam}))`);
    }
    if (filter?.userId !== undefined) {
      joins.push(`JOIN user_clusters uc ON uc.cluster_id = c.id AND uc.role != 'invited'`);
      bindings.push(filter.userId);
      parts.push(`uc.user_id = $${bindings.length}`);
    }
    if (filter?.ownerId !== undefined) {
      joins.push(`JOIN user_clusters owner_uc ON owner_uc.cluster_id = c.id AND owner_uc.role = 'owner'`);
      bindings.push(filter.ownerId);
      parts.push(`owner_uc.user_id = $${bindings.length}`);
    }
    if (filter?.instanceId !== undefined) {
      joins.push(`JOIN instances inst ON inst.cluster_id = c.id`);
      bindings.push(filter.instanceId);
      parts.push(`inst.id = $${bindings.length}`);
    }

    let baseSql = `FROM clusters c`;
    if (joins.length) {
      baseSql += ` ${joins.join(" ")}`;
    }
    if (parts.length) {
      baseSql += ` WHERE ${parts.join(" AND ")}`;
    }

    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count ${baseSql}`)
      .bind(...bindings)
      .first();
    const total = Number(countResult?.count ?? 0);

    // When filtering by userId, include the user's role and cluster owner name.
    const userRoleSelect = filter?.userId !== undefined
      ? `, uc.role AS user_role, (SELECT u.name FROM users u JOIN user_clusters ouc ON u.id = ouc.user_id WHERE ouc.cluster_id = c.id AND ouc.role = 'owner' LIMIT 1) AS owner_name`
      : "";

    let sql = `SELECT c.id, c.name, c.metadata, c.pool_instance_id, c.created_at, c.updated_at${userRoleSelect} ${baseSql} ORDER BY c.created_at DESC`;
    const dataBindings = [...bindings];

    if (filter?.limit !== undefined) {
      dataBindings.push(filter.limit);
      sql += ` LIMIT $${dataBindings.length}`;
    }
    if (filter?.offset !== undefined) {
      dataBindings.push(filter.offset);
      sql += ` OFFSET $${dataBindings.length}`;
    }

    const clusters = await this.db.prepare(sql).bind(...dataBindings).all();

    const result: Cluster[] = [];
    for (const cluster of clusters.results) {
      const usersStmt = this.db.prepare(`
        SELECT user_id, role FROM user_clusters WHERE cluster_id = $1
      `);

      const userRoles = await usersStmt.bind(cluster.id as string).all();
      const users: string[] = [];
      const roles: Record<UserRole, string[]> = {
        owner: [],
        admin: [],
        developer: [],
        viewer: [],
        invited: [],
      };

      for (const userRole of userRoles.results) {
        const userId = userRole.user_id as string;
        const role = userRole.role as UserRole;

        if (!users.includes(userId)) {
          users.push(userId);
        }

        if (!roles[role]) {
          roles[role] = [];
        }
        roles[role].push(userId);
      }

      result.push({
        id: cluster.id as string,
        name: cluster.name as string,
        users,
        roles,
        poolInstanceId: (cluster.pool_instance_id as string) ?? null,
        metadata: (cluster as any).metadata || {},
        createdAt: Number(cluster.created_at),
        updatedAt: Number(cluster.updated_at),
        ...(filter?.userId !== undefined && {
          role: (cluster as any).user_role as string,
          owner: (cluster as any).owner_name as string ?? undefined,
        }),
      });
    }

    return { clusters: result, total };
  }

  async get(id: string): Promise<Cluster | null> {
    const clusterStmt = this.db.prepare(`
      SELECT id, name, metadata, pool_instance_id, created_at, updated_at
      FROM clusters WHERE id = $1
    `);

    const cluster = await clusterStmt.bind(id).first();
    if (!cluster) return null;

    const usersStmt = this.db.prepare(`
      SELECT user_id, role FROM user_clusters WHERE cluster_id = $1
    `);

    const userRoles = await usersStmt.bind(id).all();
    const users: string[] = [];
    const roles: Record<UserRole, string[]> = {
      owner: [],
      admin: [],
      developer: [],
      viewer: [],
      invited: [],
    };

    for (const userRole of userRoles.results) {
      const userId = userRole.user_id as string;
      const role = userRole.role as UserRole;

      if (!users.includes(userId)) {
        users.push(userId);
      }

      if (!roles[role]) {
        roles[role] = [];
      }
      roles[role].push(userId);
    }

    return {
      id: cluster.id as string,
      name: cluster.name as string,
      users,
      roles,
      poolInstanceId: (cluster.pool_instance_id as string) ?? null,
      metadata: (cluster as any).metadata || {},
      createdAt: Number(cluster.created_at),
      updatedAt: Number(cluster.updated_at),
    };
  }

  async upsert(userId: string): Promise<Cluster> {
    return this.db.withTransaction(async (client) => {
      const existingResult = await client.query(
        `SELECT c.id, c.name, c.metadata, c.pool_instance_id, c.created_at, c.updated_at
         FROM clusters c
         JOIN user_clusters uc ON uc.cluster_id = c.id
         WHERE uc.user_id = $1 AND uc.role = 'owner'`,
        [userId],
      );

      if (existingResult.rows.length > 0) {
        const r = existingResult.rows[0];
        return {
          id: r.id as string,
          name: r.name as string,
          users: [userId],
          roles: { owner: [userId], admin: [], developer: [], viewer: [], invited: [] },
          poolInstanceId: (r.pool_instance_id as string) ?? null,
          metadata: r.metadata || {},
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        };
      }

      const userResult = await client.query(`SELECT email FROM users WHERE id = $1`, [userId]);
      if (!userResult.rows.length) throw new ResourceNotFoundError("user");

      const id = this.generateId();
      const name = (userResult.rows[0].email as string).split("@")[0];

      try {
        await client.query(`INSERT INTO clusters (id, name) VALUES ($1, $2)`, [id, name]);
        await client.query(`INSERT INTO user_clusters (user_id, cluster_id, role) VALUES ($1, $2, 'owner')`, [userId, id]);
      } catch (error) {
        this.parsePostgresError(error);
      }

      const clusterResult = await client.query(
        `SELECT id, name, metadata, pool_instance_id, created_at, updated_at FROM clusters WHERE id = $1`,
        [id],
      );

      if (!clusterResult.rows.length) throw new Error(`Failed to create cluster for user ${userId}`);

      const clusterRow = clusterResult.rows[0];
      return {
        id: clusterRow.id as string,
        name: clusterRow.name as string,
        users: [userId],
        roles: { owner: [userId], admin: [], developer: [], viewer: [], invited: [] },
        poolInstanceId: (clusterRow.pool_instance_id as string) ?? null,
        metadata: clusterRow.metadata || {},
        createdAt: Number(clusterRow.created_at),
        updatedAt: Number(clusterRow.updated_at),
      };
    });
  }

  async update(id: string, updates: Partial<Omit<Cluster, "id" | "createdAt">>): Promise<Cluster | null> {
    if (!updates.name && !updates.metadata && !updates.roles) {
      return this.get(id);
    }

    if (updates.roles?.owner && updates.roles.owner.length > 0) {
      throw new ValidationError("Cannot update owner role through update(). Use transferOwnership() instead.");
    }

    // Prepare all statements for atomic execution
    const statements = [];

    // Handle cluster table updates
    const clusterUpdates: Record<string, any> = {};
    if (updates.name) clusterUpdates.name = updates.name;

    if (updates.metadata) {
      statements.push(
        this.db
          .prepare(
            `
          UPDATE clusters 
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
              updated_at = $2
          WHERE id = $3
        `,
          )
          .bind(updates.metadata, this.now(), id),
      );
    }

    // Handle other cluster field updates
    if (Object.keys(clusterUpdates).length > 0) {
      const fields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const [field, value] of Object.entries(clusterUpdates)) {
        fields.push(`${field} = $${paramIndex++}`);
        values.push(value);
      }

      fields.push(`updated_at = $${paramIndex++}`);
      values.push(this.now(), id);

      const query = `UPDATE clusters SET ${fields.join(", ")} WHERE id = $${paramIndex}`;
      statements.push(this.db.prepare(query).bind(...values));
    }

    // Handle role updates
    if (updates.roles) {
      const roleStatements = await this.prepareRoleUpdateStatements(id, updates.roles);
      statements.push(...roleStatements);
    }

    // Execute all updates atomically
    if (statements.length > 0) {
      await this.db.batch(statements);
    }

    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM clusters WHERE id = $1`).bind(id).run();
  }

  async installGitHubIntegration(clusterId: string, integration: Omit<GitHubIntegration, "remotesCount">): Promise<Cluster | null> {
    const cluster = await this.get(clusterId);
    if (!cluster) {
      return null;
    }

    await this.db
      .prepare(
        `
      UPDATE clusters 
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gitHub}', $1::jsonb)
          WHERE id = $2
    `,
      )
      .bind(integration, clusterId)
      .run();

    return this.get(clusterId);
  }

  /**
   * Add multiple users to a cluster (excluding owner role).
   * Creates users if they don't exist and adds them with 'invited' role.
   *
   * @param clusterId - The cluster ID
   * @param userEmails - Array of user emails with their target roles
   */
  async addUsers(clusterId: string, userEmails: string[]): Promise<void> {
    if (userEmails.length === 0) return;

    const now = this.now();
    const statements: PreparedStatement[] = [];

    for (const email of userEmails) {
      const userId = this.generateId();
      const name = email.split("@")[0];
      const provider = "email";

      // Insert user if doesn't exist
      statements.push(
        this.db
          .prepare(
            `
          INSERT INTO users (id, name, email, provider, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT(email) DO NOTHING
        `,
          )
          .bind(userId, name, email, provider, now, now),
      );

      // Link user to cluster with 'invited' role
      statements.push(
        this.db
          .prepare(
            `
          INSERT INTO user_clusters (user_id, cluster_id, role)
          SELECT id, $1, 'invited' FROM users WHERE email = $2
          ON CONFLICT (user_id, cluster_id) DO NOTHING
        `,
          )
          .bind(clusterId, email),
      );
    }

    try {
      await this.db.batch(statements);
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  /**
   * Remove multiple users from a cluster.
   * Cannot remove cluster owners - use transferOwnership() first.
   *
   * @param clusterId - The cluster ID
   * @param userIds - Array of user IDs to remove
   */
  async removeUsers(clusterId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;

    await this.db.withTransaction(async (client) => {
      for (const userId of userIds) {
        const roleResult = await client.query(
          `SELECT role FROM user_clusters WHERE user_id = $1 AND cluster_id = $2`,
          [userId, clusterId],
        );
        if (roleResult.rows[0]?.role === "owner") {
          throw new ValidationError("Cannot remove cluster owner. Transfer ownership using transferOwnership().");
        }
      }

      for (const userId of userIds) {
        await client.query(`DELETE FROM user_clusters WHERE cluster_id = $1 AND user_id = $2`, [clusterId, userId]);

        // Clean up uninitialized accounts (invited-only users with no remaining clusters)
        await client.query(
          `DELETE FROM users
           WHERE id = $1
           AND provider = 'email'
           AND NOT EXISTS (SELECT 1 FROM user_clusters WHERE user_id = $1)`,
          [userId],
        );
      }
    });
  }

  /**
   * Accept a cluster invite and upgrade to specified role.
   *
   * @param userId - The user ID accepting the invite
   * @param clusterId - The cluster ID
   */
  async acceptInvite(userId: string, clusterId: string): Promise<void> {
    const stmt = this.db.prepare(`
       UPDATE user_clusters 
       SET role = 'viewer', updated_at = $1
       WHERE user_id = $2 AND cluster_id = $3 AND role = 'invited'
     `);

    const result = await stmt.bind(this.now(), userId, clusterId).run();

    if (result.meta.changes === 0) {
      throw new ResourceNotFoundError("invite");
    }
  }

  /**
   * Decline a cluster invite (removes the user from cluster).
   *
   * @param userId - The user ID declining the invite
   * @param clusterId - The cluster ID
   */
  async declineInvite(userId: string, clusterId: string): Promise<void> {
    const stmt = this.db.prepare(`
       DELETE FROM user_clusters 
       WHERE user_id = $1 AND cluster_id = $2 AND role = 'invited'
     `);

    const result = await stmt.bind(userId, clusterId).run();

    if (result.meta.changes === 0) {
      throw new ResourceNotFoundError("invite");
    }
  }

  /**
   * List pending invites for a user.
   *
   * @param userId - The user ID
   * @returns Array of cluster IDs with pending invites
   */
  async listPendingInvites(userId: string): Promise<{ clusterId: string; clusterName: string; ownerName: string }[]> {
    const stmt = this.db.prepare(`
      SELECT 
        uc.cluster_id,
        c.name as cluster_name,
        u.name as owner_name
      FROM user_clusters uc
      JOIN clusters c ON uc.cluster_id = c.id
      JOIN user_clusters owner_uc ON owner_uc.cluster_id = c.id AND owner_uc.role = 'owner'
      JOIN users u ON owner_uc.user_id = u.id
      WHERE uc.user_id = $1 AND uc.role = 'invited'
    `);
    const results = await stmt.bind(userId).all();
    return results.results.map((r) => ({
      clusterId: r.cluster_id as string,
      clusterName: r.cluster_name as string,
      ownerName: r.owner_name as string,
    }));
  }

  /**
   * Transfers cluster ownership from current owner to a new owner.
   * Ensures there is always exactly one owner per cluster.
   *
   * @param clusterId - The cluster ID
   * @param newOwnerId - The user ID of the new owner
   * @param previousOwnerRole - Optional role to assign to the previous owner (defaults to 'admin'). Cannot be 'owner'. Use null to remove from cluster.
   *
   * @example
   * ```typescript
   * // Transfer ownership, previous owner becomes admin (default)
   * await store.clusters.transferOwnership("cluster123", "newOwner456");
   *
   * // Transfer ownership, previous owner becomes developer
   * await store.clusters.transferOwnership("cluster123", "newOwner456", "developer");
   *
   * // Transfer ownership and remove previous owner from cluster
   * await store.clusters.transferOwnership("cluster123", "newOwner456", null);
   * ```
   */
  async transferOwnership(clusterId: string, newOwnerId: string, previousOwnerRole: Exclude<UserRole, "owner"> = "admin"): Promise<void> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE user_clusters 
         SET role = $1 
         WHERE cluster_id = $2 AND user_id != $3 AND role = 'owner'`,
          )
          .bind(previousOwnerRole, clusterId, newOwnerId),

        this.db
          .prepare(
            `INSERT INTO user_clusters (user_id, cluster_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (user_id, cluster_id) DO UPDATE SET role = 'owner'`,
          )
          .bind(newOwnerId, clusterId),
      ]);
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  /**
   * Gets a cluster that belongs to a user (excludes invited).
   *
   * @param userId - The user ID
   * @returns A cluster
   */
  async getUserOwnedCluster(userId: string): Promise<Pick<Cluster, "id" | "name" | "metadata"> | null> {
    const cluster = await this.find({ userId });
    if (!cluster) return null;
    return { id: cluster.id, name: cluster.name, metadata: cluster.metadata };
  }

  async listUnassigned(): Promise<{ id: string }[]> {
    const result = await this.db.prepare(`SELECT id FROM clusters WHERE pool_instance_id IS NULL`).all();
    return result.results.map((r) => ({ id: r.id as string }));
  }

  async listUsers(
    clusterId: string,
    filter?: { invited?: boolean; limit?: number; offset?: number },
  ): Promise<{ users: (User & { role: UserRole })[]; total: number }> {
    const roleCondition =
      filter?.invited === true ? `uc.role = 'invited'` : filter?.invited === false ? `uc.role != 'invited'` : `TRUE`;

    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count FROM users u JOIN user_clusters uc ON u.id = uc.user_id WHERE uc.cluster_id = $1 AND ${roleCondition}`)
      .bind(clusterId)
      .first();
    const total = Number(countResult?.count ?? 0);

    const bindings: any[] = [clusterId];
    let sql = `SELECT u.id, u.name, u.email, u.picture, u.provider, u.created_at, u.updated_at, uc.role
      FROM users u
      JOIN user_clusters uc ON u.id = uc.user_id
      WHERE uc.cluster_id = $1 AND ${roleCondition}
      ORDER BY uc.role DESC, u.email ASC`;

    if (filter?.limit !== undefined) {
      bindings.push(filter.limit);
      sql += ` LIMIT $${bindings.length}`;
    }
    if (filter?.offset !== undefined) {
      bindings.push(filter.offset);
      sql += ` OFFSET $${bindings.length}`;
    }

    const results = await this.db.prepare(sql).bind(...bindings).all();
    const users = results.results.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      email: row.email as string,
      picture: row.picture as string,
      provider: row.provider as OAuthProvider,
      role: row.role as UserRole,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));

    return { users, total };
  }

  /**
   * Gets the user's role in a cluster.
   *
   * @param userId - The user ID
   * @param clusterId - The cluster ID
   * @returns The role, or null if relationship doesn't exist
   */
  async getUserRole(userId: string, clusterId: string): Promise<UserRole | null> {
    const stmt = this.db.prepare(`SELECT role FROM user_clusters WHERE user_id = $1 AND cluster_id = $2`);
    const result = await stmt.bind(userId, clusterId).first();
    return result ? (result.role as UserRole) : null;
  }

  /**
   * Gets the current owner of a cluster.
   *
   * @param clusterId - The cluster ID
   * @returns The owner's user ID, or null if no owner found
   */
  async getOwner(clusterId: string): Promise<string | null> {
    const stmt = this.db.prepare(`SELECT user_id FROM user_clusters WHERE cluster_id = $1 AND role = 'owner'`);
    const result = await stmt.bind(clusterId).first();
    return result ? (result.user_id as string) : null;
  }

  /**
   * Gets all users with a specific role in a cluster.
   * Owner role cannot be retrieved through this method - use getOwner() instead.
   *
   * @param clusterId - The cluster ID
   * @param role - The role to filter by
   * @returns Array of user IDs with the specified role
   *
   * @example
   * ```typescript
   * const admins = await store.clusters.getUsersByRole("cluster123", "admin");
   * // Returns: ["user456", "user789"]
   * ```
   */
  async getUsersByRole(clusterId: string, role: Exclude<UserRole, "owner">): Promise<string[]> {
    const stmt = this.db.prepare(`SELECT user_id FROM user_clusters WHERE cluster_id = $1 AND role = $2`);
    const results = await stmt.bind(clusterId, role).all();
    return results.results.map((r) => r.user_id as string);
  }

  /**
   * Gets a list of integrations active in a cluster
   *
   * @param clusterId - The cluster ID
   * @returns Integration containing a mapping of each optional role
   */
  async listClusterIntegrations(clusterId: string): Promise<Integrations> {
    const stmt = this.db.prepare(`
      SELECT metadata FROM clusters WHERE id = $1
    `);
    const result = await stmt.bind(clusterId).first();
    const metadata = result?.metadata ? (result as any).metadata : {};

    // Default event subscriptions for all notification integrations
    const defaultNotificationEvents = [
      EVENTS.INSTANCE.CREATED.code,
      EVENTS.INSTANCE.UPDATED.code,
      EVENTS.INSTANCE.DELETED.code,
      EVENTS.CLUSTER.INVITE_ACCEPTED.code,
      EVENTS.CLUSTER.USER_INVITED.code,
      EVENTS.CLUSTER.REMOVED_USER.code,
      EVENTS.CLUSTER.USER_ROLE_CHANGED.code,
    ];

    const ensureEvents = (integration: any) => {
      if (!integration) return integration;
      return {
        ...integration,
        events: integration.events || defaultNotificationEvents,
      };
    };

    const integrations: Integrations = {
      remote: {
        gitHub: metadata?.gitHub,
        gitLab: metadata?.gitLab,
        bitBucket: metadata?.bitBucket,
      },
      email: {
        resendMail: metadata?.resendMail,
        zohoMail: metadata?.zohoMail,
        mailerSend: metadata?.mailerSend,
        mailChimp: metadata?.mailChimp,
      },
      notification: {
        discord: ensureEvents(metadata?.discord),
        slack: ensureEvents(metadata?.slack),
        customWebhook: ensureEvents(metadata?.customWebhook),
        email: ensureEvents(metadata?.emailNotification),
      },
    };
    return integrations;
  }

  /**
   * Gets a cluster by its name.
   * Used by traffic router to resolve cluster from subdomain.
   *
   * @param name - The cluster name (e.g., "production", "staging")
   * @returns The cluster if found, null otherwise
   */
  async getByName(name: string): Promise<Cluster | null> {
    const result = await this.db.prepare(`SELECT * FROM clusters WHERE LOWER(name) = LOWER($1)`).bind(name).first<any>();

    if (!result) return null;

    // Fetch users and roles
    const usersResult = await this.db
      .prepare(
        `
            SELECT u.email, uc.role 
            FROM user_clusters uc 
            JOIN users u ON uc.user_id = u.id 
            WHERE uc.cluster_id = $1
        `,
      )
      .bind(result.id)
      .all<{ email: string; role: UserRole }>();

    const users = usersResult.results?.map((r) => r.email) ?? [];
    const roles: Record<UserRole, string[]> = {
      owner: [],
      admin: [],
      developer: [],
      viewer: [],
      invited: [],
    };

    for (const row of usersResult.results ?? []) {
      if (roles[row.role]) {
        roles[row.role].push(row.email);
      }
    }

    return {
      id: result.id,
      name: result.name,
      users,
      roles,
      poolInstanceId: result.pool_instance_id ?? null,
      metadata: result.metadata ? JSON.parse(result.metadata) : undefined,
      createdAt: Number(result.created_at),
      updatedAt: Number(result.updated_at),
    };
  }

  /**
   * Gets a cluster by instance ID.
   * Used by traffic router to validate service-instance-cluster relationship.
   *
   * @param instanceId - The instance ID
   * @returns The cluster if found, null otherwise
   */
  async getByInstanceId(instanceId: string): Promise<Cluster | null> {
    return this.find({ instanceId });
  }

  /**
   * Validates that a service belongs to a cluster.
   * Used by traffic router for security validation.
   *
   * @param serviceName - The service name
   * @param clusterName - The cluster name
   * @returns Object with validation result and details
   */
  async validateServiceCluster(
    serviceName: string,
    clusterName: string,
  ): Promise<{
    valid: boolean;
    serviceId?: string;
    instanceId?: string;
    instanceAddress?: string;
    clusterId?: string;
  }> {
    const result = await this.db
      .prepare(
        `
          SELECT
            s.id       AS service_id,
            s.name     AS service_name,
            c.id       AS cluster_id,
            c.name     AS cluster_name,
            COALESCE(ded.address, pool.address) AS instance_address
          FROM services s
          JOIN clusters c ON s.cluster_id = c.id
          LEFT JOIN instances ded  ON ded.cluster_id = c.id AND ded.kind = 'dedicated'
          LEFT JOIN instances pool ON pool.id = c.pool_instance_id
          WHERE LOWER(s.name)    = LOWER($1)
            AND LOWER(c.name)    = LOWER($2)
            AND COALESCE(ded.address, pool.address) IS NOT NULL
          LIMIT 1
        `,
      )
      .bind(serviceName, clusterName)
      .first<{
        service_id: string;
        instance_id: string;
        instance_address: string;
        cluster_id: string;
      }>();

    if (!result) {
      return { valid: false };
    }

    return {
      valid: true,
      serviceId: result.service_id,
      instanceId: result.instance_id,
      instanceAddress: result.instance_address,
      clusterId: result.cluster_id,
    };
  }

  // Permission checks
  async canRead(userId: string, clusterId: string): Promise<boolean> {
    return this.hasMinRole(userId, clusterId, "viewer");
  }

  async canWrite(userId: string, clusterId: string): Promise<boolean> {
    return this.hasMinRole(userId, clusterId, "developer");
  }

  async isAdmin(userId: string, clusterId: string): Promise<boolean> {
    return this.hasMinRole(userId, clusterId, "admin");
  }

  async isOwner(userId: string, clusterId: string): Promise<boolean> {
    return this.hasMinRole(userId, clusterId, "owner");
  }

  private async hasMinRole(userId: string, clusterId: string, minRole: UserRole): Promise<boolean> {
    const userRole = await this.getUserRole(userId, clusterId);
    if (!userRole) return false;

    const userLevel = this.ROLE_HIERARCHY[userRole as UserRole] ?? 0;
    const requiredLevel = this.ROLE_HIERARCHY[minRole];

    return userLevel >= requiredLevel;
  }

  /**
   * Prepares statements for updating cluster roles (excluding owner role).
   * Owner role cannot be changed through this method - use transferOwnership() instead.
   *
   * @private
   * @param clusterId - The cluster ID
   * @param roles - New role assignments (owner role is ignored if present)
   * @returns Array of prepared statements for batch execution
   */
  private async prepareRoleUpdateStatements(clusterId: string, roles: Record<Exclude<UserRole, "owner">, string[]>): Promise<PreparedStatement[]> {
    const { ...members } = roles;

    // Calculate highest role per user
    const userRoleMap = new Map<string, UserRole>();
    for (const [role, userIds] of Object.entries(members)) {
      const roleLevel = this.ROLE_HIERARCHY[role as UserRole] ?? 0;
      for (const userId of userIds) {
        const currentRole = userRoleMap.get(userId);
        const currentLevel = currentRole ? this.ROLE_HIERARCHY[currentRole] : 0;
        if (roleLevel > currentLevel) {
          userRoleMap.set(userId, role as UserRole);
        }
      }
    }

    // Get current users
    const currentUsers = await this.db.prepare(`SELECT DISTINCT user_id FROM user_clusters WHERE cluster_id = $1 AND role != 'owner'`).bind(clusterId).all();

    const statements = [];

    // Remove users not in new roles
    for (const row of currentUsers.results) {
      const userId = row.user_id as string;
      if (!userRoleMap.has(userId)) {
        statements.push(this.db.prepare(`DELETE FROM user_clusters WHERE cluster_id = $1 AND user_id = $2 AND role != 'owner'`).bind(clusterId, userId));
      }
    }

    // Upsert all desired roles
    for (const [userId, role] of userRoleMap) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO user_clusters (user_id, cluster_id, role) VALUES ($1, $2, $3)
                    ON CONFLICT (user_id, cluster_id) DO UPDATE SET role = $3`,
          )
          .bind(userId, clusterId, role),
      );
    }

    return statements;
  }

  async count(filter?: { id?: string; name?: string }): Promise<number> {
    const { clause, bindings } = this.buildWhere({
      id: filter?.id,
      name: filter?.name,
    });
    const row = await (bindings.length
      ? this.db.prepare(`SELECT COUNT(*) AS count FROM clusters ${clause}`).bind(...bindings).first<{ count: string }>()
      : this.db.prepare(`SELECT COUNT(*) AS count FROM clusters`).first<{ count: string }>());
    return Number(row?.count ?? 0);
  }
}
