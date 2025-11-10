import { Cluster, Role } from "@/types";
import { BaseStore } from "./base";

export class ClusterStore extends BaseStore {
  private readonly ROLE_HIERARCHY = {
    viewer: 1,
    developer: 2,
    admin: 3,
    owner: 4,
  } as const;

  async create(adminUserId: string): Promise<Cluster> {
    const id = this.generateId();
    const now = this.now();

    // Get user info and check for existing cluster
    const stmt = this.db.prepare(`
      WITH user_info AS (
        SELECT email, 
               substr(email, 1, instr(email, '@') - 1) as cluster_name
        FROM users WHERE id = ?
      ),
      existing_cluster AS (
        SELECT c.id, c.name, c.metadata, c.created_at, c.updated_at
        FROM clusters c
        JOIN user_clusters uc ON c.id = uc.cluster_id
        WHERE uc.user_id = ? AND uc.role = 'owner'
      )
      SELECT 
        COALESCE(ec.id, ?) as id,
        COALESCE(ec.name, ui.cluster_name) as name,
        COALESCE(ec.metadata, '{}') as metadata,
        COALESCE(ec.created_at, ?) as created_at,
        COALESCE(ec.updated_at, ?) as updated_at,
        ui.email,
        CASE WHEN ec.id IS NULL THEN 1 ELSE 0 END as is_new
      FROM user_info ui
      LEFT JOIN existing_cluster ec ON 1=1
    `);

    const result = await stmt.bind(adminUserId, adminUserId, id, now, now).first();

    if (!result) {
      throw new Error(`User ${adminUserId} not found`);
    }

    const isNew = result.is_new as number;
    const clusterId = result.id as string;
    const clusterName = result.name as string;
    const bootstrapId = null;

    // Only create if new
    if (isNew) {
      const statements = [
        this.db.prepare(`
          INSERT INTO clusters (id, name, bootstrap_id, metadata, created_at, updated_at)
          VALUES (?, ?, ?, '{}', ?, ?)
        `).bind(clusterId, clusterName, bootstrapId, now, now),

        this.db.prepare(`
          INSERT INTO user_clusters (user_id, cluster_id, role) VALUES (?, ?, 'owner')
        `).bind(adminUserId, clusterId)
      ];

      await this.db.batch(statements);
    }

    return {
      id: clusterId,
      name: clusterName,
      users: [adminUserId],
      bootstrapId,
      roles: {
        owner: [adminUserId],
        admin: [],
        developer: [],
        viewer: [],
      },
      metadata: result.metadata ? JSON.parse(result.metadata as string) : {},
      createdAt: result.created_at as number,
      updatedAt: result.updated_at as number,
    };
  }

  async get(id: string): Promise<Cluster | null> {
    const clusterStmt = this.db.prepare(`
      SELECT id, name, bootstrap_id, metadata, created_at, updated_at 
      FROM clusters WHERE id = ?
    `);

    const cluster = await clusterStmt.bind(id).first();
    if (!cluster) return null;

    const usersStmt = this.db.prepare(`
      SELECT user_id, role FROM user_clusters WHERE cluster_id = ?
    `);

    const userRoles = await usersStmt.bind(id).all();
    const users: string[] = [];
    const roles: Record<Role, string[]> = {
      owner: [],
      admin: [],
      developer: [],
      viewer: [],
    };

    for (const userRole of userRoles.results) {
      const userId = userRole.user_id as string;
      const role = userRole.role as Role;

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
      bootstrapId: cluster.bootstrap_id as number,
      roles,
      metadata: cluster.metadata ? JSON.parse(cluster.metadata as string) : {},
      createdAt: cluster.created_at as number,
      updatedAt: cluster.updated_at as number,
    };
  }

  async update(
    id: string,
    updates: Partial<Omit<Cluster, "id" | "createdAt">>
  ): Promise<Cluster | null> {
    if (!updates.name && !updates.bootstrapId && !updates.metadata && !updates.roles) {
      return this.get(id);
    }

    if (updates.roles?.owner && updates.roles.owner.length > 0) {
      throw new Error('Cannot update owner role through update(). Use transferOwnership() instead.');
    }

    // Prepare all statements for atomic execution
    const statements = [];

    // Handle cluster table updates
    const clusterUpdates: Record<string, any> = {};
    if (updates.name) clusterUpdates.name = updates.name;

    if (updates.bootstrapId !== undefined) {
      // Get the current cluster and check if there's no bootstrap id
      const cluster = await this.db.prepare(`
        SELECT bootstrap_id FROM clusters WHERE id = ?
      `).bind(id).first();

      if (!cluster) {
        throw new Error(`Cluster ${id} not found`);
      }

      const bootstrapId = cluster.bootstrap_id as number | null;

      // Bootstrap id can be set only once 
      // throw error if it's already set (non-null)
      if (bootstrapId !== null) {
        throw new Error('Bootstrap ID can only be assigned once');
      }

      clusterUpdates.bootstrap_id = updates.bootstrapId;
    }

    if (updates.metadata) {
      // Use atomic JSON merge
      const updatesJson = JSON.stringify(updates.metadata);
      statements.push(
        this.db.prepare(`
          UPDATE clusters 
          SET metadata = json_patch(COALESCE(metadata, '{}'), ?),
              updated_at = ?
          WHERE id = ?
        `).bind(updatesJson, this.now(), id)
      );
    }

    // Handle other cluster field updates
    if (Object.keys(clusterUpdates).length > 0) {
      const fields: string[] = [];
      const values: any[] = [];

      for (const [field, value] of Object.entries(clusterUpdates)) {
        fields.push(`${field} = ?`);
        values.push(value);
      }

      fields.push("updated_at = ?");
      values.push(this.now(), id);

      const query = `UPDATE clusters SET ${fields.join(", ")} WHERE id = ?`;
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
    await this.db.prepare(`DELETE FROM clusters WHERE id = ?`).bind(id).run();
  }

  async addUser(
    clusterId: string,
    userId: string,
    role: Exclude<Role, 'owner'> = "viewer"
  ): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO user_clusters (user_id, cluster_id, role) VALUES (?, ?, ?)`
    );
    await stmt.bind(userId, clusterId, role).run();
  }

  async removeUser(clusterId: string, userId: string): Promise<void> {
    const userRole = await this.getUserRole(userId, clusterId);
    if (userRole === 'owner') {
      throw new Error('Cannot remove cluster owner. Transfer ownership first using transferOwnership().');
    }

    await this.db
      .prepare(`DELETE FROM user_clusters WHERE cluster_id = ? AND user_id = ?`)
      .bind(clusterId, userId)
      .run();
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
  async transferOwnership(
    clusterId: string,
    newOwnerId: string,
    previousOwnerRole?: Exclude<Role, 'owner'> | null
  ): Promise<void> {
    // Default to 'admin' if not specified
    const roleForPreviousOwner = previousOwnerRole === undefined ? 'admin' : previousOwnerRole;

    // Get current owner
    const currentOwnerStmt = this.db.prepare(`
      SELECT user_id FROM user_clusters WHERE cluster_id = ? AND role = 'owner'
    `);
    const currentOwner = await currentOwnerStmt.bind(clusterId).first();

    if (!currentOwner) {
      throw new Error('No current owner found for cluster');
    }

    const currentOwnerId = currentOwner.user_id as string;

    if (currentOwnerId === newOwnerId) {
      throw new Error('User is already the owner of this cluster');
    }

    const statements = [];

    // Remove current owner
    statements.push(
      this.db.prepare(`DELETE FROM user_clusters WHERE cluster_id = ? AND user_id = ?`)
        .bind(clusterId, currentOwnerId)
    );

    // Add new owner
    statements.push(
      this.db.prepare(`INSERT OR REPLACE INTO user_clusters (user_id, cluster_id, role) VALUES (?, ?, 'owner')`)
        .bind(newOwnerId, clusterId)
    );

    // Assign role to previous owner (if specified)
    if (roleForPreviousOwner) {
      statements.push(
        this.db.prepare(`INSERT INTO user_clusters (user_id, cluster_id, role) VALUES (?, ?, ?)`)
          .bind(currentOwnerId, clusterId, roleForPreviousOwner)
      );
    }

    await this.db.batch(statements);
  }

  /**
   * Gets a list of clusters that belongs to a user.
   * 
   * @param userId - The user ID
   * @returns A list of cluster IDs
   */
  async listUserClusters(userId: string): Promise<string[]> {
    const stmt = this.db.prepare(
      `SELECT DISTINCT cluster_id FROM user_clusters WHERE user_id = ?`
    );
    const results = await stmt.bind(userId).all();
    return results.results.map((r) => r.cluster_id as string);
  }

  /**
   * Gets the user's role in a cluster.
   * 
   * @param userId - The user ID
   * @param clusterId - The cluster ID
   * @returns The role, or null if relationship doesn't exist
   */
  async getUserRole(userId: string, clusterId: string): Promise<Role | null> {
    const stmt = this.db.prepare(
      `SELECT role FROM user_clusters WHERE user_id = ? AND cluster_id = ?`
    );
    const result = await stmt.bind(userId, clusterId).first();
    return result ? (result.role as Role) : null;
  }

  /**
   * Gets the current owner of a cluster.
   * 
   * @param clusterId - The cluster ID
   * @returns The owner's user ID, or null if no owner found
   */
  async getOwner(clusterId: string): Promise<string | null> {
    const stmt = this.db.prepare(
      `SELECT user_id FROM user_clusters WHERE cluster_id = ? AND role = 'owner'`
    );
    const result = await stmt.bind(clusterId).first();
    return result ? (result.user_id as string) : null;
  }

  /**
   * Gets all users with a specific role in a cluster. (excluding owner role).
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
  async getUsersByRole(clusterId: string, role: Exclude<Role, 'owner'>): Promise<string[]> {
    const stmt = this.db.prepare(
      `SELECT user_id FROM user_clusters WHERE cluster_id = ? AND role = ?`
    );
    const results = await stmt.bind(clusterId, role).all();
    return results.results.map((r) => r.user_id as string);
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

  private async hasMinRole(
    userId: string,
    clusterId: string,
    minRole: Role
  ): Promise<boolean> {
    const userRole = await this.getUserRole(userId, clusterId);
    if (!userRole) return false;

    const userLevel = this.ROLE_HIERARCHY[userRole] || 0;
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
  private async prepareRoleUpdateStatements(
    clusterId: string,
    roles: Record<Exclude<Role, 'owner'>, string[]>
  ): Promise<D1PreparedStatement[]> {
    const { ...members } = roles;

    // Calculate highest role per user
    const userRoleMap = new Map<string, Role>();
    for (const [role, userIds] of Object.entries(members)) {
      const roleLevel = this.ROLE_HIERARCHY[role as Role];
      for (const userId of userIds) {
        const currentRole = userRoleMap.get(userId);
        const currentLevel = currentRole ? this.ROLE_HIERARCHY[currentRole] : 0;
        if (roleLevel > currentLevel) {
          userRoleMap.set(userId, role as Role);
        }
      }
    }

    // Get current users
    const currentUsers = await this.db
      .prepare(`SELECT DISTINCT user_id FROM user_clusters WHERE cluster_id = ? AND role != 'owner'`)
      .bind(clusterId)
      .all();

    const statements = [];

    // Remove users not in new roles
    for (const row of currentUsers.results) {
      const userId = row.user_id as string;
      if (!userRoleMap.has(userId)) {
        statements.push(
          this.db
            .prepare(`DELETE FROM user_clusters WHERE cluster_id = ? AND user_id = ? AND role != 'owner'`)
            .bind(clusterId, userId)
        );
      }
    }

    // Upsert all desired roles
    for (const [userId, role] of userRoleMap) {
      statements.push(
        this.db
          .prepare(`INSERT OR REPLACE INTO user_clusters (user_id, cluster_id, role) VALUES (?, ?, ?)`)
          .bind(userId, clusterId, role)
      );
    }

    return statements;
  }

  /**
   * Updates cluster roles (excluding owner role).
   * Owner role cannot be changed through this method - use transferOwnership() instead.
   * 
   * @private
   * @param clusterId - The cluster ID
   * @param roles - New role assignments (owner role is ignored if present)
   */
  private async updateRoles(
    clusterId: string,
    roles: Record<Exclude<Role, 'owner'>, string[]>
  ): Promise<void> {
    const statements = await this.prepareRoleUpdateStatements(clusterId, roles);

    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }
}
