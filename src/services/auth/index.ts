// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseStore } from "@/lib/db/store/db/index.js";
import type { KVStore } from "@/lib/db/store/kv/index.js";
import type { Bindings, OAuthProvider, User } from "@/types/index.js";
import type { VmProvider } from "@/services/vm/index.js";
import type { JWTService } from "./jwt.js";
import type { EmailProvider } from "@/services/notifications/email/index.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { loginCodeTemplate } from "@/lib/templates/emails/verificationCode.js";
import { buildInstallScript, DEFAULT_CAPACITY, DEFAULT_INSTANCE_IMAGE, DEFAULT_INSTANCE_REGION, DEFAULT_INSTANCE_SIZE, DEFAULT_INSTANCE_TAGS } from "@/lib/constants/vm.js";
import { ulid } from "ulid";

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
  async loginWithOAuth({ email, provider, name, picture, metadata }: {
    email: string;
    provider: OAuthProvider;
    name: string;
    picture?: string;
    metadata?: Record<string, any>;
  }): Promise<User> {
    const existing = await this.db.users.find({ email });
    const userToSave = existing
      ? { email, name: existing.name, provider, metadata: metadata ?? {} }
      : { email, name, picture, provider, metadata: metadata ?? {} };

    const user = await this.db.users.save(userToSave);
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

    const user = await this.db.users.save({
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
  async sendOTP({ email, emailProvider }: { email: string; emailProvider: EmailProvider }): Promise<void> {
    const code = await this.kv.createOTP(email);
    const name = email.split("@")[0] ?? email;
    await emailProvider.sendEmail({
      to: email,
      name,
      subject: "Verify your account",
      body: loginCodeTemplate(name, code),
    });
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
  async provisionCluster({ userId, vmService, jwt }: {
    userId: string;
    vmService?: VmProvider;
    jwt?: JWTService;
  }): Promise<{ id: string } | null> {
    let cluster: { id: string; poolInstanceId?: string | null } | null = null;

    try {
      cluster = await this.db.clusters.upsert(userId);
    } catch (err) {
      console.error("[Auth] Failed to upsert cluster for user", userId, err);
      return null;
    }

    if (!cluster || cluster.poolInstanceId) return cluster;

    try {
      await this.db.instancePool.assign(cluster.id);
    } catch (err) {
      if (err instanceof PoolCapacityExceededError && vmService && jwt) {
        await this.spawnPoolInstance({ clusterId: cluster.id, vmService, jwt });
      } else {
        console.error("[Auth] Failed to assign pool instance for cluster", cluster.id, err);
      }
    }

    return cluster;
  }

  /**
   * Creates a new session for the user and returns the session ID alongside
   * the user's cluster list.
   */
  async createSession({ user }: { user: User }): Promise<{ sessionId: string; clusters: { id: string; name: string; owner: string; role: string }[] }> {
    const sessionId = crypto.randomUUID();
    const clusters = await this.db.clusters.listUserClusters(user.id);
    await this.kv.createSession(sessionId, user, clusters);
    return { sessionId, clusters };
  }

  /** Provisions a new VM, registers it in the instance pool, and assigns it to the cluster. */
  private async spawnPoolInstance({ clusterId, vmService, jwt }: {
    clusterId: string;
    vmService: VmProvider;
    jwt: JWTService;
  }): Promise<void> {
    try {
      const instanceId = ulid();
      const name = "instance-pool-" + Date.now().toString();
      const token = await jwt.createBootstrapToken(name);
      const decoded = await jwt.verifyToken(token);
      await this.db.bootstrapTokens.create(instanceId, decoded.nonce as string);

      const vm = await vmService.create({
        image: DEFAULT_INSTANCE_IMAGE,
        name,
        region: DEFAULT_INSTANCE_REGION,
        size: DEFAULT_INSTANCE_SIZE,
        tags: DEFAULT_INSTANCE_TAGS,
        sshKey: this.env.SSH_KEY,
        userData: buildInstallScript(token, name),
      });

      await this.db.instancePool.add({
        address: vm.ipv4 ?? null,
        capacity: DEFAULT_CAPACITY,
        tag: name,
        region: vm.region,
        status: "healthy",
      });

      await this.db.instancePool.assign(clusterId);
    } catch (err) {
      console.error("[Auth/Pools] Failed to provision pool instance for cluster", clusterId, err);
    }
  }
}
