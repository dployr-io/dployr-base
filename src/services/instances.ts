// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Bindings, Instance, Session } from "@/types/index.js";
import { EVENTS } from "@/lib/constants/index.js";
import { Context } from "hono";
import { ulid } from "ulid";
import { getKVStore, getJWTService, getWS, getDbStore, getBillingProvider } from "@/lib/context.js";
import { InstanceConnectionFailureError, InstanceNotConnectedError, PermissionError, ResourceNotFoundError } from "@/lib/errors/errors.js";
import { DployrdService } from "./dployrd.js";
import { BillingService } from "./billing/index.js";

/**
 * Service for managing dployr instances.
 *
 * Provides methods to create, register, and manage instances that connect
 * to the base server via WebSocket.
 */
export class InstanceService {
  constructor(private env: Bindings) {}

  /**
   * Creates a new instance within a cluster.
   *
   * Creates a new instance record and generates a one-time bootstrap token
   * that the instance daemon uses to register itself with the base server.
   *
   * @param params.clusterId - The cluster ULID to create the instance in
   * @param params.tag - Unique instance name (3-15 characters)
   * @param params.address - IPv4 address of the instance
   * @param params.userId - ID of the user creating the instance
   * @param params.c - Hono context with request bindings
   * @param params.metadata - Optional metadata for the instance
   * @returns Object containing the created instance and one-time bootstrap token
   */
  async createInstance({
    clusterId,
    tag,
    address,
    userId,
    c,
    metadata,
  }: {
    clusterId: string;
    tag: string;
    address: string;
    userId: string;
    c: Context;
    metadata?: Record<string, any> | undefined;
  }): Promise<{ instance: Instance; token: string }> {
    const db = getDbStore(c);
    const kv = getKVStore(c);
    const nonce = crypto.randomUUID();

    const instance = await db.instances.create({
      clusterId,
      nonce,
      data: {
        tag,
        address,
        metadata,
      } as any,
    });

    await kv.logEvent({
      actor: {
        id: userId,
        type: "user",
      },
      targets: [
        {
          id: clusterId,
        },
      ],
      type: EVENTS.BOOTSTRAP.BOOTSTRAP_SETUP_COMPLETED.code,
      request: c.req.raw,
    });

    const jwt = getJWTService(c);
    const token = await jwt.createBootstrapToken(instance.tag);
    const decoded = await jwt.verifyToken(token);
    await db.bootstrapTokens.create(instance.id, decoded.nonce as string);

    return { instance, token };
  }

  /**
   * Gets or creates a JWT token for user access to an instance.
   *
   * Returns a cached token if available, otherwise creates a new
   * short-lived access token with viewer role for the user to
   * authenticate with the instance daemon.
   *
   * @param params.session - Current user session
   * @param params.instanceId - Instance ID to generate token for
   * @param params.c - Hono context with request bindings
   * @returns JWT access token for the user to communicate with the instance
   */
  async getOrCreateInstanceUserToken({ session, instanceId, c }: { session: Session; instanceId: string; c: Context }): Promise<string> {
    const kv = getKVStore(c);
    const db = getDbStore(c);
    const role = "viewer";
    const key = `inst:${instanceId}:user:${session.userId}:role:${role}:token`;

    try {
      const raw = await kv.kv.get(key);
      const cached = typeof raw === "string" ? (JSON.parse(raw) as { token?: string } | null) : null;
      const tok = cached && typeof cached.token === "string" ? cached.token : undefined;
      if (typeof tok === "string" && tok.trim().length > 0) {
        return tok;
      }
    } catch {}

    const instance = await db.instances.get(instanceId);
    if (!instance) {
      throw new Error("Instance not found");
    }

    const jwt = getJWTService(c);
    const token = await jwt.createInstanceAccessToken(session, instance.tag, role, { issuer: this.env.BASE_URL, audience: "dployr-daemon" });

    let ttl = 240;
    try {
      const payload = await jwt.verifyToken(token);
      const expSec = typeof (payload as any).exp === "number" ? (payload as any).exp : 0;
      const nowMs = Date.now();
      const expMs = expSec * 1000;
      const bufferMs = 10_000;
      const remainMs = expMs - nowMs - bufferMs;
      ttl = Math.max(0, Math.floor(remainMs / 1000));
    } catch {}

    try {
      if (ttl > 0) {
        await kv.kv.put(key, JSON.stringify({ token }), { ttl: ttl });
      }
    } catch {}

    return token;
  }

  /**
   * Rotates a bootstrap token for an instance.
   *
   * Verifies the provided bootstrap token and rotates it to a new token,
   * extending the instance's registration window. The token must be
   * the valid previously assigned bootstrap token for the specified instance.
   *
   * @param params.token - Current bootstrap token to rotate
   * @param params.instanceId - Instance ID the token is for
   * @param params.c - Hono context with request bindings
   * @returns New rotated bootstrap token
   */
  async rotateInstanceBootstrapToken({ token, instanceId, c }: { token: string; instanceId: string; c: Context }): Promise<string> {
    const db = getDbStore(c);
    const kv = getKVStore(c);
    const jwt = getJWTService(c);
    let payload: any;

    try {
      payload = await jwt.verifyTokenIgnoringExpiry(token);
    } catch (e) {
      throw new Error("invalid token signature", e as Error);
    }

    if (payload.token_type !== "bootstrap") {
      throw new Error("invalid token type");
    }

    const instance = await db.instances.get(instanceId);
    if (!instance) {
      throw new ResourceNotFoundError("instance");
    }

    if (payload.instance_id !== instance.tag) {
      throw new Error("invalid bootstrap token for instance");
    }

    const nonce = payload.nonce as string | undefined;
    if (!nonce) {
      throw new Error("invalid bootstrap token payload");
    }

    return await jwt.rotateBootstrapToken(instance.tag, nonce, "5m");
  }

  /**
   * Pings an instance to check connectivity.
   *
   * Verifies the instance exists by looking up by name.
   * Currently returns "enqueued" as nodes connect via WebSocket
   * and receive tasks directly.
   *
   * @param params.instanceName - Name of the instance to ping
   * @param params.c - Hono context with request bindings
   * @returns "enqueued" indicating the ping was processed
   */
  async pingInstance({ instanceName, c }: { instanceName: string; c: Context }): Promise<"enqueued"> {
    const db = getDbStore(c);
    const kv = getKVStore(c);
    const instance = await db.instances.getByName(instanceName);

    if (!instance) {
      throw new Error("Instance not found");
    }

    // Task queuing removed - nodes connect via WebSocket and receive tasks directly
    // TODO: Implement task queue if async task delivery is needed
    // For now, tasks are sent when node is connected via WS
    return "enqueued";
  }

  /**
   * Registers an instance daemon with the base server.
   *
   * Validates the bootstrap token and marks it as used to prevent
   * replay attacks. Returns the instance name and JWKS URL
   * for the daemon to fetch signing keys.
   *
   * @param params.token - One-time bootstrap token from createInstance
   * @param params.c - Hono context with request bindings
   * @returns Registration result with instance name and JWKS URL, or error reason
   */
  async registerInstance({
    token,
    c,
  }: {
    token: string;
    c: Context;
  }): Promise<{ ok: true; instanceName: string; jwksUrl: string } | { ok: false; reason: "invalid_token" | "invalid_type" | "already_used" }> {
    const kv = getKVStore(c);
    const db = getDbStore(c);
    const jwt = getJWTService(c);

    let payload: any;
    try {
      payload = await jwt.verifyToken(token);
    } catch {
      return { ok: false, reason: "invalid_token" };
    }

    if (payload.token_type !== "bootstrap") {
      return { ok: false, reason: "invalid_type" };
    }

    const wasUnused = await db.bootstrapTokens.markUsed(payload.nonce as string);
    if (!wasUnused) {
      return { ok: false, reason: "already_used" };
    }

    return {
      ok: true,
      instanceName: payload.instance_id,
      jwksUrl: `${this.env.BASE_URL}/v1/jwks/.well-known/jwks.json`,
    };
  }

  /**
   * Saves the domain for an instance.
   *
   * Associates the instance's address with a subdomain on
   * dployr.io and returns the full domain name.
   *
   * @param params.instanceName - Name of the instance
   * @param params.c - Hono context with request bindings
   * @returns Full domain name (e.g., "my-instance.dployr.io")
   */
  async saveDomain({ instanceName, c }: { instanceName: string; c: Context }) {
    const db = getDbStore(c);
    const kv = getKVStore(c);
    const instance = await db.instances.getByName(instanceName);

    if (!instance) {
      throw new Error("Instance not found");
    }

    await kv.saveDomain({ domain: instance.tag, address: instance.address });

    return `${instance.tag}.dployr.io`;
  }

  /**
   * Lists instances in a cluster.
   *
   * Returns a paginated list of instances belonging to the
   * specified cluster.
   *
   * @param params.clusterId - Cluster ULID to list instances from
   * @param params.c - Hono context with request bindings
   * @param params.limit - Maximum number of instances to return
   * @param params.offset - Number of instances to skip
   * @returns Array of instances and total count
   */
  async listInstances({ c, clusterId, limit, offset }: { c: Context; clusterId?: string; limit?: number; offset?: number }): Promise<{ instances: any[]; total: number }> {
    const db = getDbStore(c);
    return db.instances.list({ clusterId, limit, offset });
  }

  /**
   * Gets a single instance by ID.
   *
   * @param params.instanceId - Instance ID to retrieve
   * @param params.c - Hono context with request bindings
   * @returns Instance object with clusterId, or null if not found
   */
  async getInstance({ instanceId, c }: { instanceId: string; c: Context }): Promise<
    | (Instance & {
        clusterId: string;
      })
    | null
  > {
    const db = getDbStore(c);
    const instance = await db.instances.get(instanceId);
    if (!instance) {
      throw new Error("Instance not found");
    }
    return instance;
  }

  /**
   * Deletes an instance.
   *
   * Permanently removes the instance and its associated data.
   * Requires owner permission on the cluster.
   *
   * @param params.instanceId - Instance ID to delete
   * @param params.c - Hono context with request bindings
   */
  async deleteInstance({ instanceId, c }: { instanceId: string; c: Context }): Promise<void> {
    const db = getDbStore(c);
    const instance = await db.instances.get(instanceId);
    if (!instance) {
      throw new Error("Instance not found");
    }
    await db.instances.delete(instanceId);
  }

  /**
   * Installs or upgrades the dployr daemon on an instance.
   *
   * Sends a system install task to the instance daemon via
   * WebSocket to download and install the specified dployr version.
   * Requires owner permission on the cluster.
   *
   * @param params.instanceId - Instance ID to install on
   * @param params.clusterId - Cluster containing the instance
   * @param params.version - Dployr version to install
   * @param params.c - Hono context with request bindings
   * @returns Task ID for the install operation
   */
  async installDployr({ instanceId, clusterId, version, c }: { instanceId: string; clusterId: string; version: string; c: Context }): Promise<string> {
    const db = getDbStore(c);
    const session = c.get("session")!;
    const kv = getKVStore(c);
    const jwtService = getJWTService(c);

    const instance = await db.instances.get(instanceId);
    if (!instance) {
      throw new ResourceNotFoundError("instance");
    }

    if (instance.clusterId !== clusterId) {
      throw new PermissionError("owner");
    }
    const ws = getWS(c);
    if (!ws.hasNodeConnection(clusterId)) {
      throw new InstanceNotConnectedError(instanceId);
    }

    const dployrd = new DployrdService();
    const token = await jwtService.createInstanceAccessToken(session, instanceId, "owner", {
      issuer: c.env.BASE_URL,
      audience: "dployr-instance",
    });

    const taskId = ulid();
    const task = dployrd.createSystemInstallTask(taskId, version, token);

    const sent = ws.sendTaskToCluster(clusterId, task);
    if (!sent) {
      throw new InstanceConnectionFailureError(instanceId);
    }

    return task.ID;
  }

  /**
   * Reboots an instance.
   *
   * Sends a daemon restart task to the instance via WebSocket.
   * The force parameter controls whether to wait for pending tasks.
   * Requires admin permission on the cluster.
   *
   * @param params.instanceId - Instance ID to reboot
   * @param params.clusterId - Cluster containing the instance
   * @param params.force - Whether to force restart without waiting
   * @param params.c - Hono context with request bindings
   * @returns Task ID for the reboot operation
   */
  async rebootInstance({ instanceId, clusterId, force, c }: { instanceId: string; clusterId: string; force: boolean; c: Context }): Promise<string> {
    const db = getDbStore(c);
    const session = c.get("session")!;
    const kv = getKVStore(c);
    const jwtService = getJWTService(c);

    const instance = await db.instances.get(instanceId);
    if (!instance) {
      throw new ResourceNotFoundError("instance");
    }

    if (instance.clusterId !== clusterId) {
      throw new PermissionError("admin");
    }
    const ws = getWS(c);
    if (!ws.hasNodeConnection(clusterId)) {
      throw new InstanceNotConnectedError(instanceId);
    }

    const dployrd = new DployrdService();
    const token = await jwtService.createInstanceAccessToken(session, instanceId, "admin", {
      issuer: c.env.BASE_URL,
      audience: "dployr-instance",
    });

    const taskId = ulid();
    const task = dployrd.createDaemonRestartTask(taskId, force, token);

    const sent = ws.sendTaskToCluster(clusterId, task);
    if (!sent) {
      throw new InstanceConnectionFailureError(instanceId);
    }

    return task.ID;
  }

  /**
   * Restarts the dployr daemon on an instance.
   *
   * Sends a daemon restart task to the instance via WebSocket.
   * Alias for rebootInstance - requires admin permission.
   *
   * @param params.instanceId - Instance ID to restart daemon on
   * @param params.clusterId - Cluster containing the instance
   * @param params.force - Whether to force restart without waiting
   * @param params.c - Hono context with request bindings
   * @returns Task ID for the restart operation
   */
  async restartDaemon({ instanceId, clusterId, force, c }: { instanceId: string; clusterId: string; force: boolean; c: Context }): Promise<string> {
    const db = getDbStore(c);
    const session = c.get("session")!;
    const kv = getKVStore(c);
    const jwtService = getJWTService(c);

    const instance = await db.instances.get(instanceId);
    if (!instance) {
      throw new ResourceNotFoundError("instance");
    }

    if (instance.clusterId !== clusterId) {
      throw new PermissionError("admin");
    }
    const ws = getWS(c);
    if (!ws.hasNodeConnection(clusterId)) {
      throw new InstanceNotConnectedError(instanceId);
    }

    const dployrd = new DployrdService();
    const token = await jwtService.createInstanceAccessToken(session, instanceId, "admin", {
      issuer: c.env.BASE_URL,
      audience: "dployr-instance",
    });

    const taskId = ulid();
    const task = dployrd.createDaemonRestartTask(taskId, force, token);

    const sent = ws.sendTaskToCluster(clusterId, task);
    if (!sent) {
      throw new InstanceConnectionFailureError(instanceId);
    }

    return task.ID;
  }

  async resolveFreeInstance({ c, clusterId }: { c: any; clusterId?: string }) {
    if (!clusterId) return null;

    const billingProvider = getBillingProvider(c);
    if (!billingProvider) return null;

    const billingService = new BillingService(billingProvider, c.env);
    const db = getDbStore(c);

    const status = await billingService.getStatus({ clusterId, db });
    if (status.plan !== "hobby") return null;

    const kv = getKVStore(c);
    const [freeInstanceId, pool] = await Promise.all([kv.getClusterFreeInstance(clusterId), kv.getFreeInstancePool()]);

    if (!freeInstanceId || !pool) return null;

    const freeInstance = pool.find((inst) => inst.id === freeInstanceId);
    if (!freeInstance) return null;

    const now = Date.now();

    return {
      ...freeInstance,
      metadata: {
        ...freeInstance.metadata,
        managed: true,
      },
      clusterId,
      createdAt: now,
      updatedAt: now,
    };
  }
}
