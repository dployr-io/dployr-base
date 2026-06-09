// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseStore } from "@/lib/db/store/db/index.js";
import type { KVStore } from "@/lib/db/store/kv/index.js";
import type { Bindings, OAuthProvider, User } from "@/types/index.js";
import type { VmProvider } from "@/services/vm/index.js";
import type { JWTService } from "./jwt.js";
import type { EmailService } from "@/services/notifications/email/index.js";
import type { InstancePool } from "@/services/pool.js";
import { otpEmail } from "@/lib/templates/emails/index.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("AuthService");

export class AuthService {
  constructor(
    private db: DatabaseStore,
    private kv: KVStore,
    private env: Bindings,
  ) {}

  /**
   * Upserts a user after a successful OAuth sign-in.
   * Preserves the existing display name when the account already exists.
   */
  async loginWithOAuth({ email, provider, name, picture, metadata }: { email: string; provider: OAuthProvider; name: string; picture?: string; metadata?: Record<string, any> }): Promise<User> {
    const existing = await this.db.users.find({ email });
    const userToSave = existing ? { email, name: existing.name, provider, metadata: metadata ?? {} } : { email, name, picture, provider, metadata: metadata ?? {} };

    const user = await this.db.users.upsert(userToSave);
    if (!user) throw new Error("Failed to save user");
    return user;
  }

  /**
   * Returns the existing user for the given email, or creates one if this is
   * their first email sign-in.
   */
  async findOrCreateEmailUser({ email }: { email: string }): Promise<User> {
    const existing = await this.db.users.find({ email });
    if (existing) return existing;

    const user = await this.db.users.upsert({
      email,
      name: email.split("@")[0] ?? email,
      provider: "email" as OAuthProvider,
      metadata: {},
    });
    if (!user) throw new Error("Failed to create user");
    return user;
  }

  /**
   * Generates a one-time code and sends it to the given email address.
   */
  async sendOTP({ email, emailService }: { email: string; emailService: EmailService }): Promise<void> {
    const code = await this.kv.createOTP(email);
    const name = email.split("@")[0] ?? email;
    await emailService.send(email, otpEmail, { name, code });
  }

  /**
   * Validates the OTP code for the given email.
   * Always returns true in test environments.
   */
  async verifyOTP({ email, code }: { email: string; code: string }): Promise<boolean> {
    if (process.env.NODE_ENV === "test") return true;
    return this.kv.validateOTP({ email, code: code.toUpperCase() });
  }

  /**
   * Upserts a cluster for the user and assigns a pool instance.
   * If the pool is at capacity and VM/JWT services are provided, a new
   * instance is provisioned automatically.
   */
  async provisionCluster({ userId, vmService, jwt, pool }: { userId: string; vmService?: VmProvider; jwt?: JWTService; pool?: InstancePool }): Promise<{ id: string } | null> {
    let cluster: { id: string; poolInstanceId?: string | null } | null = null;

    try {
      cluster = await this.db.clusters.upsert(userId);
    } catch (err) {
      log.error(`Failed to upsert cluster for user ${userId}:`, { error: err instanceof Error ? err.message : String(err) });
      return null;
    }

    if (!cluster || cluster.poolInstanceId) return cluster;

    // Skip pool assignment if the cluster already has a dedicated instance (pro tier).
    const dedicated = await this.db.instances.find({ clusterId: cluster.id, kind: "dedicated" });
    if (dedicated) return cluster;

    try {
      await this.db.instances.assignPool(cluster.id, "hobby");
    } catch (error) {
      if (error instanceof PoolCapacityExceededError && pool) {
        await pool.spawnPoolInstance({ clusterId: cluster.id, tier: "hobby" });
      } else {
        log.error(`Failed to assign pool instance for cluster ${cluster.id}:`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    return cluster;
  }

  /**
   * Creates a new session for the user and returns the session ID alongside
   * the user's cluster list.
   */
  async createSession({ user, meta }: { user: User; meta?: { ip?: string; userAgent?: string; country?: string } }): Promise<{ sessionId: string; clusters: { id: string; name: string; owner: string; role: string }[] }> {
    const sessionId = crypto.randomUUID();
    const { clusters: userClusters } = await this.db.clusters.list({ userId: user.id });
    const clusters = userClusters.map((cl) => ({ id: cl.id, name: cl.name, owner: cl.owner ?? "", role: cl.role ?? "" }));
    await this.kv.createSession(sessionId, user, clusters, undefined, meta);
    return { sessionId, clusters };
  }
}
