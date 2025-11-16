import { Cluster, OAuthProvider, Role as UserRole, User, Integrations, GitHubIntegration } from "@/types";
import { BaseStore } from "./base";

export class ClusterStore extends BaseStore {
  private readonly ROLE_HIERARCHY = {
    invited: 0,
    viewer: 1,
    developer: 2,
    admin: 3,
    owner: 4,
  } as const;

  async save(adminUserId: string): Promise<Cluster> {
    // Check if user already owns a cluster
    const existingCluster = await this.db
      .prepare(`
        SELECT c.id, c.name, c.metadata, c.created_at, c.updated_at
        FROM clusters c
        JOIN user_clusters uc ON uc.cluster_id = c.id
        WHERE uc.user_id = ? AND uc.role = 'owner'
      `)
      .bind(adminUserId)
      .first();

    if (existingCluster) {
      return {
        id: existingCluster.id as string,
        name: existingCluster.name as string,
        users: [adminUserId],
        roles: {
          owner: [adminUserId],
          admin: [],
          developer: [],
          viewer: [],
          invited: [],
        },
        metadata: existingCluster.metadata ? JSON.parse(existingCluster.metadata as string) : {},
        createdAt: existingCluster.created_at as number,
        updatedAt: existingCluster.updated_at as number,
      };
    }

    // Create new cluster
    const id = this.generateId();

    const user = await this.db
      .prepare(`SELECT email, metadata FROM users WHERE id = ?`)
      .bind(adminUserId)
      .first();

    if (!user) {
      throw new Error(`User ${adminUserId} not found`);
    }

    const name = (user.email as string).split('@')[0];

    await this.db.batch([
      this.db.prepare(`INSERT INTO clusters (id, name, metadata) VALUES (?, ?)`).bind(id, name),
      this.db.prepare(`INSERT INTO user_clusters (user_id, cluster_id, role) VALUES (?, ?, 'owner')`).bind(adminUserId, id),
    ]);

    const clusterRow = await this.db
      .prepare(`SELECT id, name, metadata, created_at, updated_at FROM clusters WHERE id = ?`)
      .bind(id)
      .first();

    if (!clusterRow) {
      throw new Error(`Failed to create cluster for user ${adminUserId}`);
    }

    return {
      id: clusterRow.id as string,
      name: clusterRow.name as string,
      users: [adminUserId],
      roles: {
        owner: [adminUserId],
        admin: [],
        developer: [],
        viewer: [],
        invited: [],
      },
      metadata: clusterRow.metadata ? JSON.parse(clusterRow.metadata as string) : {},
      createdAt: clusterRow.created_at as number,
      updatedAt: clusterRow.updated_at as number,
    };
  }

  async get(id: string): Promise<Cluster | null> {
    const clusterStmt = this.db.prepare(`
      SELECT id, name, metadata, created_at, updated_at 
      FROM clusters WHERE id = ?
    `);

    const cluster = await clusterStmt.bind(id).first();
    if (!cluster) return null;

    const usersStmt = this.db.prepare(`
      SELECT user_id, role FROM user_clusters WHERE cluster_id = ?
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
      metadata: cluster.metadata ? JSON.parse(cluster.metadata as string) : {},
      createdAt: cluster.created_at as number,
      updatedAt: cluster.updated_at as number,
    };
  }

  async update(
    id: string,
    updates: Partial<Omit<Cluster, "id" | "createdAt">>
  ): Promise<Cluster | null> {
    if (!updates.name && !updates.metadata && !updates.roles) {
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

  async installGitHubIntegration(
    integration: Partial<Omit<GitHubIntegration, "remotesCount">>
  ): Promise<Cluster | null> {
    const cluster = await this.db.prepare(`
      SELECT id, metadata FROM clusters 
      WHERE json_extract(metadata, '$.gitHub.loginId') = ?
    `).bind(integration.loginId).first();

    if (!cluster) {
      return null;
    }

    const clusterId = cluster.id as string;

    // Update the cluster's GitHub integration metadata
    const updatesJson = JSON.stringify(integration);
    await this.db.prepare(`
      UPDATE clusters 
      SET metadata = json_patch(COALESCE(metadata, '{}'), json_object('gitHub', json(?)))
          WHERE id = ?
    `).bind(updatesJson, clusterId).run();

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
    const statements: D1PreparedStatement[] = [];

    for (const email of userEmails) {
      const userId = this.generateId();
      const name = email.split("@")[0];
      const provider = "email";

      // Insert user if doesn't exist
      statements.push(
        this.db.prepare(`
          INSERT INTO users (id, name, email, provider, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(email) DO NOTHING
        `).bind(userId, name, email, provider, now, now)
      );

      // Link user to cluster with 'invited' role
      statements.push(
        this.db.prepare(`
          INSERT OR IGNORE INTO user_clusters (user_id, cluster_id, role)
          SELECT id, ?, 'invited' FROM users WHERE email = ?
        `).bind(clusterId, email)
      );
    }

    await this.db.batch(statements);
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

    // Check if any user is an owner
    for (const userId of userIds) {
      const userRole = await this.getUserRole(userId, clusterId);
      if (userRole === 'owner') {
        throw new Error('Cannot remove cluster owner. Transfer ownership using transferOwnership().');
      }
    }

    const statements: D1PreparedStatement[] = [];

    for (const userId of userIds) {
      statements.push(
        this.db.prepare(`DELETE FROM user_clusters WHERE cluster_id = ? AND user_id = ?`)
          .bind(clusterId, userId)
      );

      // Check if user has any other clusters
      // By design, if user has a cluster we're sure their account has been initialized.
      // Clean up uninitialized accounts (users with no clusters and provider = 'email')
      statements.push(
        this.db.prepare(`
          DELETE FROM users 
          WHERE id = ? 
          AND provider = 'email'
          AND NOT EXISTS (
            SELECT 1 FROM user_clusters WHERE user_id = ?
          )
        `).bind(userId, userId)
      );
    }

    await this.db.batch(statements);
  }

  /**
   * Accept a cluster invite and upgrade to specified role.
   * 
   * @param userId - The user ID accepting the invite
   * @param clusterId - The cluster ID
   */
  async acceptInvite(
    userId: string,
    clusterId: string
  ): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE user_clusters 
      SET role = 'viewer', updated_at = ?
      WHERE user_id = ? AND cluster_id = ? AND role = 'invited'
    `);

    const result = await stmt.bind(this.now(), userId, clusterId).run();

    if (result.meta.changes === 0) {
      throw new Error('No invite found');
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
      WHERE user_id = ? AND cluster_id = ? AND role = 'invited'
    `);

    const result = await stmt.bind(userId, clusterId).run();

    if (result.meta.changes === 0) {
      throw new Error('No invite found');
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
      WHERE uc.user_id = ? AND uc.role = 'invited'
    `);
    const results = await stmt.bind(userId).all();
    return results.results.map((r) => ({
      clusterId: r.cluster_id as string,
      clusterName: r.cluster_name as string,
      ownerName: r.owner_name as string
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
  async transferOwnership(
    clusterId: string,
    newOwnerId: string,
    previousOwnerRole: Exclude<UserRole, 'owner'> = 'admin'
  ): Promise<void> {
    // Demote the previous owner
    await this.db
      .prepare(
        `UPDATE user_clusters SET role = ? WHERE cluster_id = ? AND user_id != ? AND role = 'owner'`
      )
      .bind(previousOwnerRole, clusterId, newOwnerId)
      .run();

    // Promote the new owner
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO user_clusters (user_id, cluster_id, role) VALUES (?, ?, 'owner')`
      )
      .bind(newOwnerId, clusterId)
      .run();
  }

  /**
   * Gets a list of clusters that belongs to a user (excludes invited).
   * 
   * @param userId - The user ID
   * @returns A list of cluster IDs
   */
  async listUserClusters(userId: string): Promise<string[]> {
    const stmt = this.db.prepare(
      `SELECT DISTINCT cluster_id FROM user_clusters WHERE user_id = ? AND role != 'invited'`
    );
    const results = await stmt.bind(userId).all();
    return results.results.map((r) => r.cluster_id as string);
  }

  /**
 * Gets a list of users in a cluster (excludes invited users)
 * 
 * @param clusterId - The cluster ID
 * @param limit - Optional limit for pagination
 * @param offset - Optional offset for pagination
 * @returns A custom object of users and their roles with total count
 */
  async listClusterUsers(
    clusterId: string,
    limit?: number,
    offset?: number
  ): Promise<{ users: (User & { role: UserRole })[]; total: number }> {
    // Get total count
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM users u
      JOIN user_clusters uc ON u.id = uc.user_id
      WHERE uc.cluster_id = ? AND uc.role != 'invited'
    `);
    const countResult = await countStmt.bind(clusterId).first();
    const total = (countResult?.count as number) || 0;
    const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';
    const offsetClause = offset !== undefined ? `OFFSET ${offset}` : '';

    const stmt = this.db.prepare(`
      SELECT u.id, u.name, u.email, u.picture, u.provider, u.created_at, u.updated_at, uc.role
      FROM users u
      JOIN user_clusters uc ON u.id = uc.user_id
      WHERE uc.cluster_id = ? AND uc.role != 'invited'
      ORDER BY uc.role DESC, u.email ASC
      ${limitClause} ${offsetClause}
    `);
    const results = await stmt.bind(clusterId).all();
    const users = results.results.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      email: row.email as string,
      picture: row.picture as string,
      provider: row.provider as OAuthProvider,
      role: row.role as UserRole,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));

    return { users, total };
  }

  /**
  * Gets a list of invites in a cluster 
  * 
  * @param clusterId - The cluster ID
  * @param limit - Optional limit for pagination
  * @param offset - Optional offset for pagination
  * @returns A custom object of users and their roles with total count
  */
  async listClusterInvites(
    clusterId: string,
    limit?: number,
    offset?: number
  ): Promise<{ users: (User & { role: UserRole })[]; total: number }> {
    // Get total count
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM users u
      JOIN user_clusters uc ON u.id = uc.user_id
      WHERE uc.cluster_id = ? AND uc.role = 'invited'
    `);
    const countResult = await countStmt.bind(clusterId).first();
    const total = (countResult?.count as number) || 0;
    const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';
    const offsetClause = offset !== undefined ? `OFFSET ${offset}` : '';

    const stmt = this.db.prepare(`
      SELECT u.id, u.name, u.email, u.picture, u.provider, u.created_at, u.updated_at, uc.role
      FROM users u
      JOIN user_clusters uc ON u.id = uc.user_id
      WHERE uc.cluster_id = ? AND uc.role = 'invited'
      ORDER BY uc.role DESC, u.email ASC
      ${limitClause} ${offsetClause}
    `);
    const results = await stmt.bind(clusterId).all();
    const users = results.results.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      email: row.email as string,
      picture: row.picture as string,
      provider: row.provider as OAuthProvider,
      role: row.role as UserRole,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
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
    const stmt = this.db.prepare(
      `SELECT role FROM user_clusters WHERE user_id = ? AND cluster_id = ?`
    );
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
    const stmt = this.db.prepare(
      `SELECT user_id FROM user_clusters WHERE cluster_id = ? AND role = 'owner'`
    );
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
  async getUsersByRole(clusterId: string, role: Exclude<UserRole, 'owner'>): Promise<string[]> {
    const stmt = this.db.prepare(
      `SELECT user_id FROM user_clusters WHERE cluster_id = ? AND role = ?`
    );
    const results = await stmt.bind(clusterId, role).all();
    return results.results.map((r) => r.user_id as string);
  }

  /**
  * Gets a list of integrations active in a cluster
  * 
  * @param clusterId - The cluster ID
  * @returns Integration containing a mapping of each optional role
  */
  async listClusterIntegrations(
    clusterId: string,
  ): Promise<Integrations> {
    const stmt = this.db.prepare(`
      SELECT metadata FROM clusters WHERE id = ?
    `);
    const result = await stmt.bind(clusterId).first();
    const metadata = result?.metadata ? JSON.parse(result.metadata as string) : {};
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
      domain: {
        discord: metadata?.discord,
        slack: metadata?.slack,
      }
    };
    return integrations;
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
    minRole: UserRole
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
    roles: Record<Exclude<UserRole, 'owner'>, string[]>
  ): Promise<D1PreparedStatement[]> {
    const { ...members } = roles;

    // Calculate highest role per user
    const userRoleMap = new Map<string, UserRole>();
    for (const [role, userIds] of Object.entries(members)) {
      const roleLevel = this.ROLE_HIERARCHY[role as UserRole];
      for (const userId of userIds) {
        const currentRole = userRoleMap.get(userId);
        const currentLevel = currentRole ? this.ROLE_HIERARCHY[currentRole] : 0;
        if (roleLevel > currentLevel) {
          userRoleMap.set(userId, role as UserRole);
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
}
