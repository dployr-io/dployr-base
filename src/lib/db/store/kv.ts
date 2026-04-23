// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ActorType, Session, User } from "@/types/index.js";
import { ulid } from "ulid";
import { CryptoKey, importPKCS8, SignJWT } from "jose";
import { ADMIN_JWT_TTL, ADMIN_JWT_REFRESH_THRESHOLD, BILLING_NOTIFICATION_TTL } from "@/lib/constants/index.js";
import { generateKeyPair } from "@/lib/crypto/keystore.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv-keys.js";
import {
  FAILED_WORKFLOW_EVENT_TTL,
  OTP_TTL,
  SESSION_TTL,
  STATE_TTL,
  EVENT_TTL,
  NODE_UPDATE_TTL,
  RELEASE_CACHE_TTL,
  DEDUP_TTL,
  PENDING_GITHUB_INSTALL_TTL,
  INSTANCE_STATUS_TTL,
} from "@/lib/constants/index.js";
import { JsonWebKey } from "crypto";

/** Shape of a free instance entry stored in the pool. */
export interface FreeInstanceEntry {
  id: string;
  address: string;
  tag: string;
  capacity: number;
  region?: string;
  status?: "active" | "paused";
  metadata?: { managed: boolean; tier: string };
}

export class KVStore {
  constructor(
    public kv: IKVAdapter,
    private githubToken?: string,
  ) {}

  /**
   * Creates a new authenticated session for a user and persists it in KV.
   *
   * Writes two keys — one keyed by `sessionId` (the cookie value) and one
   * keyed by `userId` — so sessions can be looked up in either direction.
   * Both entries share the same TTL defined by `SESSION_TTL`.
   *
   * @param sessionId - The unique session identifier (stored as a cookie).
   * @param user - The authenticated user, excluding timestamps.
   * @param clusters - The list of clusters the user belongs to with their roles.
   * @returns The created `Session` object.
   */
  async createSession(sessionId: string, user: Omit<User, "createdAt" | "updatedAt">, clusters: { id: string; name: string; owner: string; role: string }[]): Promise<Session> {
    const session: Session = {
      userId: user.id,
      email: user.email,
      provider: user.provider,
      clusters,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
    };

    const ttl = SESSION_TTL;

    await Promise.all([
      this.kv.put(KV_KEYS.SESSION(sessionId), JSON.stringify(session), { ttl }),
      this.kv.put(KV_KEYS.SESSION_BY_USER(user.id), sessionId, { ttl }),
    ]);

    return session;
  }

  /**
   * Retrieves a session by its ID, returning `null` if it does not exist or
   * has expired. Expired sessions are deleted from KV before returning.
   *
   * @param sessionId - The session identifier from the cookie.
   * @returns The `Session` if valid, or `null`.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get(KV_KEYS.SESSION(sessionId));
    if (!data) return null;

    const session = JSON.parse(data) as Session;

    if (session.expiresAt < Date.now()) {
      await this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Looks up the session ID associated with a user ID.
   * Useful for refreshing another user's session after a role or cluster change.
   *
   * @param userId - The user's unique identifier.
   * @returns The session ID string, or `null` if no active session exists.
   */
  async getSessionIdByUserId(userId: string): Promise<string | null> {
    return await this.kv.get(KV_KEYS.SESSION_BY_USER(userId));
  }

  /**
   * Updates the cluster list on an existing session without resetting its TTL.
   * Used when a user's cluster membership changes (invite accepted, removed, etc.)
   * so the session reflects the new state without forcing a re-login.
   *
   * @param sessionId - The session to update.
   * @param updates.clusters - The new cluster list to write into the session.
   */
  async refreshSession({ sessionId, updates }: { sessionId: string; updates: { clusters: Session["clusters"] } }): Promise<void> {
    const existing = await this.getSession(sessionId);
    if (!existing) return;

    const refreshed: Session = {
      ...existing,
      clusters: updates.clusters,
    };

    const remainingMs = existing.expiresAt - Date.now();
    const ttl = Math.ceil(remainingMs / 1000);

    await Promise.all([
      this.kv.put(KV_KEYS.SESSION(sessionId), JSON.stringify(refreshed), { ttl }),
      this.kv.put(KV_KEYS.SESSION_BY_USER(existing.userId), sessionId, { ttl }),
    ]);
  }

  /**
   * Deletes a session and its reverse-lookup entry by user ID.
   * If the session no longer exists in KV, only the session key is deleted
   * (the user key cannot be resolved without the session data).
   *
   * @param sessionId - The session identifier to invalidate.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      await Promise.all([
        this.kv.delete(KV_KEYS.SESSION(sessionId)),
        this.kv.delete(KV_KEYS.SESSION_BY_USER(session.userId)),
      ]);
    } else {
      await this.kv.delete(KV_KEYS.SESSION(sessionId));
    }
  }

  /**
   * Returns the stored RSA key pair, generating and persisting a new one if
   * none exists. Keys are stored indefinitely — rotation requires a manual
   * delete of the KV entry.
   *
   * @returns An object containing the public key as a JWK and the private key
   *   as a PEM-encoded PKCS#8 string.
   */
  async getOrCreateKeys(): Promise<{
    publicKeyJwk: JsonWebKey;
    privateKey: string;
  }> {
    const data = await this.kv.get(KV_KEYS.JWT_KEYS);
    let existing: { publicKeyJwk: JsonWebKey; privateKey: string } | null = null;
    if (data) {
      existing = JSON.parse(data);
    }

    if (!existing) {
      const generated = await generateKeyPair();
      existing = generated;
      await this.kv.put(KV_KEYS.JWT_KEYS, JSON.stringify(generated));
    }

    return existing;
  }

  /**
   * Returns the public key JWK, backfilling the `kid` field as `"base-key"` if
   * it was never set. The `kid` is required for the JWKS endpoint consumed by
   * instance daemons when verifying tokens.
   *
   * @returns The public key as a `JsonWebKey`.
   */
  async getPublicKey(): Promise<JsonWebKey> {
    const keys = await this.getOrCreateKeys();

    if (!(keys.publicKeyJwk as any).kid) {
      (keys.publicKeyJwk as any).kid = "base-key";
      await this.kv.put(KV_KEYS.JWT_KEYS, JSON.stringify(keys));
    }

    return keys.publicKeyJwk;
  }

  /**
   * Returns the private key as a `CryptoKey` ready for use with the Web Crypto
   * API. Used internally by `JWTService` when signing tokens.
   *
   * @returns A `CryptoKey` in RS256 sign mode.
   */
  async getPrivateKey(): Promise<CryptoKey> {
    const keys = await this.getOrCreateKeys();
    return importPKCS8(keys.privateKey, "RS256");
  }

  /**
   * Records an auditable event in KV, scoped to an actor and optionally one or
   * more target entities (e.g. clusters).
   *
   * Deduplication is enforced using the request's `x-ray-id` or `x-request-id`
   * header — if the same ray ID is seen within `DEDUP_TTL`, the event is silently
   * dropped. When targets are provided, separate event entries are written for
   * each target so they can be listed independently via `getClusterEvents`.
   *
   * @param type - The event code (e.g. `"cluster.user_invited"`).
   * @param actor - The entity performing the action, with an `id` and `type`.
   * @param targets - Optional list of entities the action was performed on.
   * @param request - The raw HTTP request, used to extract ray ID and timezone.
   */
  async logEvent({ type, actor, targets, request }: { type: string; actor: { id: string; type: ActorType }; targets?: { id: string }[]; request: Request }): Promise<void> {
    const headers = request.headers;

    const timezone = headers.get("x-timezone") || "UTC";

    const baseEvent = {
      type,
      actor,
      timestamp: Date.now(),
      timezone,
      timezoneOffset: new Date().toLocaleString("en-US", {
        timeZone: timezone,
        timeZoneName: "shortOffset",
      }),
    };

    const ray = headers.get("x-ray-id") || headers.get("x-request-id") || "";
    const targetScope = Array.isArray(targets)
      ? targets
          .map((t) => t.id)
          .sort()
          .join(",")
      : "";
    const idemKey = KV_KEYS.EVENT_IDEM(type, actor.id, ray, targetScope);
    if (ray) {
      const exists = await this.kv.get(idemKey);
      if (exists) {
        return;
      }
      await this.kv.put(idemKey, "1", { ttl: DEDUP_TTL });
    }

    if (targets && targets.length > 0) {
      const id = ulid();
      const actorEvent = {
        ...baseEvent,
        id,
        targets,
      };

      const actorKey = KV_KEYS.ACTOR_EVENT(actor.id, id);
      const writes: Promise<any>[] = [this.kv.put(actorKey, JSON.stringify(actorEvent), { ttl: EVENT_TTL })];

      for (const target of targets) {
        const event = {
          ...baseEvent,
          id,
          targets: [target],
        };
        const targetKey = KV_KEYS.TARGET_EVENT(target.id, id);
        writes.push(this.kv.put(targetKey, JSON.stringify(event), { ttl: EVENT_TTL }));
      }

      await Promise.all(writes);
    } else {
      const event = {
        ...baseEvent,
        id: ulid(),
      };

      const actorKey = KV_KEYS.ACTOR_EVENT(actor.id, event.id);
      await this.kv.put(actorKey, JSON.stringify(event), { ttl: EVENT_TTL });
    }
  }

  /**
   * Returns all events emitted by a specific user, sorted newest-first.
   * Invalid or unparseable entries are silently skipped.
   *
   * @param userId - The actor whose events to retrieve.
   * @returns An array of event objects, sorted by `timestamp` descending.
   */
  async getEvents(userId: string): Promise<any[]> {
    const result = await this.kv.list({ prefix: KV_KEYS.ACTOR_EVENT(userId, "") });
    const events = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        try {
          return JSON.parse(data);
        } catch (err) {
          console.warn("[KV] Skipping invalid event JSON", { key: key.name, err });
          return null;
        }
      }),
    );
    return events.filter((e) => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  /**
   * Returns all events targeting a specific cluster, sorted newest-first.
   * Only keys with the correct prefix are processed; any stale or malformed
   * entries are silently dropped.
   *
   * @param clusterId - The cluster whose event history to retrieve.
   * @returns An array of event objects, sorted by `timestamp` descending.
   */
  async getClusterEvents(clusterId: string): Promise<any[]> {
    const prefix = KV_KEYS.TARGET_EVENT(clusterId, "");
    const result = await this.kv.list({ prefix });
    const events = await Promise.all(
      result.map(async (key) => {
        if (!key.name.startsWith(prefix)) {
          return null;
        }
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const trimmed = data.trimStart();
        if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
          return null;
        }
        try {
          return JSON.parse(data);
        } catch (err) {
          return null;
        }
      }),
    );
    return events.filter((e) => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  /**
   * Stores a failed GitHub Actions workflow run event for later inspection.
   * Events are retained for `FAILED_WORKFLOW_EVENT_TTL` seconds (90 days).
   *
   * @param id - The GitHub workflow run ID.
   * @param data - Arbitrary metadata about the run (status, repo, URLs, etc.).
   */
  async createWorkflowFailedEvent(id: string, data: Record<string, unknown>): Promise<void> {
    await this.kv.put(KV_KEYS.WORKFLOW(id), JSON.stringify(data), {
      ttl: FAILED_WORKFLOW_EVENT_TTL,
    });
  }

  /**
   * Returns the billing notification sentinel for a cluster, or `null` if no
   * notification has been sent within the dedup window (24 hours).
   * Used to prevent repeatedly emailing users about the same billing event.
   *
   * @param clusterId - The cluster to check.
   * @returns `"1"` if a notification was recently sent, or `null`.
   */
  async getbillingNotification({ clusterId }: { clusterId: string }): Promise<String | null> {
    return await this.kv.get(KV_KEYS.BILLING_NOTIFICATION(clusterId));
  }

  /**
   * Sets a dedup sentinel indicating a billing notification was just sent for
   * a cluster. Expires after `BILLING_NOTIFICATION_TTL` (24 hours), after which
   * the cluster is eligible to receive another notification.
   *
   * @param clusterId - The cluster that was notified.
   */
  async setReminderNotification({ clusterId }: { clusterId: string }): Promise<void> {
    await this.kv.put(KV_KEYS.BILLING_NOTIFICATION(clusterId), "1", {
      ttl: BILLING_NOTIFICATION_TTL,
    });
  }


  /**
   * Persists an OAuth CSRF state token along with the `redirectUrl` to return
   * to after the OAuth flow completes. Expires after `STATE_TTL` (10 minutes).
   *
   * @param state - The random state string sent to the OAuth provider.
   * @param redirectUrl - The URL to redirect back to on successful callback.
   */
  async createState({ state, redirectUrl }: { state: string; redirectUrl: string }): Promise<void> {
    await this.kv.put(
      KV_KEYS.STATE(state),
      JSON.stringify({
        state,
        redirectUrl,
        createdAt: Date.now(),
      }),
      {
        ttl: STATE_TTL,
      },
    );
  }

  /**
   * Validates and consumes an OAuth state token. The token is deleted after a
   * successful validation to prevent replay attacks.
   *
   * @param state - The state value returned by the OAuth provider callback.
   * @returns The `redirectUrl` stored with the state, or `null` if the state
   *   is missing or invalid.
   */
  async validateState(state: string): Promise<string | null> {
    try {
      const data = await this.kv.get(KV_KEYS.STATE(state));
      if (!data) {
        console.error(`[OAuth] State validation failed: state not found in KV store (state: ${state})`);
        return null;
      }

      const stateData = JSON.parse(data) as {
        state: string;
        redirectUrl: string;
        createdAt: number;
      };

      console.log(`[OAuth] State validated successfully (redirectUrl: ${stateData.redirectUrl})`);
      await this.kv.delete(KV_KEYS.STATE(state));
      return stateData.redirectUrl;
    } catch (error) {
      console.error(`[OAuth] State validation error:`, error);
      return null;
    }
  }

  /**
   * Generates a 6-character alphanumeric OTP for the given email address and
   * stores it in KV with a `attempts` counter initialised to `0`.
   * Expires after `OTP_TTL` (10 minutes).
   *
   * @param email - The email address to generate an OTP for.
   * @returns The plaintext OTP code to be sent via email.
   */
  async createOTP(email: string): Promise<string> {
    const code = this.generateOTP();

    await this.kv.put(
      KV_KEYS.OTP(email),
      JSON.stringify({
        code,
        email,
        createdAt: Date.now(),
        attempts: 0,
      }),
      { ttl: OTP_TTL },
    );

    return code;
  }

  /**
   * Validates a submitted OTP code against the stored one for the given email.
   *
   * Increments the attempt counter on each call. After 3 failed attempts the
   * OTP is deleted and further attempts return `false`. A successful match
   * deletes the OTP immediately to prevent reuse.
   *
   * @param email - The email address the OTP was issued for.
   * @param code - The code submitted by the user (case-insensitive callers
   *   should uppercase before passing).
   * @returns `true` if the code is correct, `false` otherwise.
   */
  async validateOTP({ email, code }: { email: string; code: string }): Promise<boolean> {
    const data = await this.kv.get(KV_KEYS.OTP(email));
    if (!data) return false;

    const otpData = JSON.parse(data) as {
      code: string;
      email: string;
      createdAt: number;
      attempts: number;
    };

    if (otpData.attempts >= 3) {
      await this.kv.delete(KV_KEYS.OTP(email));
      return false;
    }

    otpData.attempts++;
    await this.kv.put(KV_KEYS.OTP(email), JSON.stringify(otpData), {
      ttl: OTP_TTL,
    });

    if (otpData.code === code) {
      await this.kv.delete(KV_KEYS.OTP(email));
      return true;
    }

    return false;
  }

  /**
   * Generates a random 6-character OTP from uppercase letters and digits.
   *
   * @returns A random 6-character string (e.g. `"A3XZ9K"`).
   */
  private generateOTP(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Maps a dployr subdomain (the instance `tag`) to its IPv4 address. Used by
   * the traffic router to resolve `{tag}.dployr.io` requests. Stored without
   * a TTL — entries persist until explicitly deleted.
   *
   * @param domain - The subdomain / instance tag (e.g. `"my-node"`).
   * @param address - The IPv4 address the domain resolves to.
   */
  async saveDomain({ domain, address }: { domain: string; address: string }): Promise<void> {
    await this.kv.put(KV_KEYS.DOMAIN(domain), address);
  }

  /**
   * Looks up the IPv4 address for a dployr subdomain.
   *
   * @param domain - The subdomain / instance tag to look up.
   * @returns The IPv4 address string, or `null` if not found.
   */
  async getDomain(domain: string): Promise<string | null> {
    const data = await this.kv.get(KV_KEYS.DOMAIN(domain));
    if (!data) return null;
    return data;
  }

  // ---------------------------------------------------------------------------
  // Node update management
  // ---------------------------------------------------------------------------

  /**
   * Persists the latest status update received from an instance daemon over
   * WebSocket. Overwrites any previous update. Expires after `NODE_UPDATE_TTL`
   * (5 minutes) — if an instance goes silent, its last known state expires.
   *
   * @param instanceId - The instance tag (not UUID) that sent the update.
   * @param update - The raw update payload from the daemon.
   */
  async saveNodeUpdate({ instanceId, update }: { instanceId: string; update: Record<string, unknown> }): Promise<void> {
    const now = Date.now();
    const data = {
      ...update,
      lastUpdated: now,
    };

    await this.kv.put(KV_KEYS.NODE_UPDATE(instanceId), JSON.stringify(data), {
      ttl: NODE_UPDATE_TTL,
    });
  }

  /**
   * Retrieves the last status update stored for an instance.
   *
   * @param instanceId - The instance tag to look up.
   * @returns The update payload, or `null` if none exists or it has expired.
   */
  async getNodeUpdate(instanceId: string): Promise<Record<string, unknown> | null> {
    const data = await this.kv.get(KV_KEYS.NODE_UPDATE(instanceId));
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Returns the cached latest dployrd release tag without hitting the GitHub
   * API. Returns `null` if the cache is empty or the stored value is malformed.
   *
   * @returns A semver tag string (e.g. `"v0.5.1"`), or `null`.
   */
  private async getCachedLatestVersion(): Promise<string | null> {
    try {
      const raw = await this.kv.get(KV_KEYS.VERSION_LATEST);
      if (!raw) return null;
      const data = JSON.parse(raw) as { tag?: string } | null;
      if (data && typeof data.tag === "string" && data.tag.length > 0) {
        return data.tag;
      }
    } catch {}
    return null;
  }

  /**
   * Fetches the latest dployrd release tag from the GitHub API and caches it
   * for `RELEASE_CACHE_TTL` (10 minutes). Uses the configured GitHub token if
   * available to avoid rate limits. Returns `null` on any network or parse error.
   *
   * @returns A semver tag string (e.g. `"v0.5.1"`), or `null`.
   */
  private async fetchAndCacheLatestVersion(): Promise<string | null> {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "dployr-base",
      };
      const token = (this.githubToken || "").trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const resp = await fetch("https://api.github.com/repos/dployr-io/dployr/releases/latest", { headers });
      if (!resp.ok) {
        return null;
      }
      const body = await resp.json();
      const tag = (body as any).tag_name as string | undefined;
      if (!tag) return null;

      await this.kv.put(KV_KEYS.VERSION_LATEST, JSON.stringify({ tag }), {
        ttl: RELEASE_CACHE_TTL,
      });

      return tag;
    } catch {
      return null;
    }
  }

  /**
   * Returns the latest dployrd release tag, using a cached value if available
   * and falling back to a live GitHub API fetch.
   *
   * @returns A semver tag string (e.g. `"v0.5.1"`), or `null` if unavailable.
   */
  async getLatestVersion(): Promise<string | null> {
    const cached = await this.getCachedLatestVersion();
    if (cached) return cached;
    return this.fetchAndCacheLatestVersion();
  }

  /**
   * Temporarily stores the `clusterId` a user was trying to link when they
   * initiated a GitHub App installation. Consumed by the OAuth callback to
   * complete the installation flow. Expires after `PENDING_GITHUB_INSTALL_TTL`
   * (10 minutes).
   *
   * @param userId - The user who initiated the installation.
   * @param clusterId - The cluster they were linking the GitHub App to.
   */
  async setPendingGitHubInstall(userId: string, clusterId: string): Promise<void> {
    await this.kv.put(KV_KEYS.PENDING_GITHUB_INSTALL(userId), clusterId, {
      ttl: PENDING_GITHUB_INSTALL_TTL,
    });
  }

  /**
   * Returns the pending cluster ID for a GitHub App installation, or `null`
   * if no pending installation exists for the user.
   *
   * @param userId - The user whose pending installation to retrieve.
   * @returns The cluster ID string, or `null`.
   */
  async getPendingGitHubInstall(userId: string): Promise<string | null> {
    return this.kv.get(KV_KEYS.PENDING_GITHUB_INSTALL(userId));
  }

  /**
   * Deletes the pending GitHub installation record for a user. Called after
   * the installation is successfully completed or abandoned.
   *
   * @param userId - The user whose pending installation to remove.
   */
  async deletePendingGitHubInstall(userId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.PENDING_GITHUB_INSTALL(userId));
  }

  /**
   * Caches an instance record under three keys for fast lookups by ID,
   * by cluster+tag, and by tag alone. All entries expire after
   * `INSTANCE_STATUS_TTL` (15 minutes).
   *
   * @param instance - The instance to cache, including `clusterId` and `tag`.
   */
  async cacheInstance(instance: { id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number }): Promise<void> {
    const data = JSON.stringify(instance);
    const ttl = INSTANCE_STATUS_TTL;

    await Promise.all([
      this.kv.put(KV_KEYS.INSTANCE_BY_ID(instance.id), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_NAME(instance.clusterId, instance.tag), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_TAG(instance.tag), data, { ttl }),
    ]);
  }

  /**
   * Retrieves a cached instance by its UUID. Returns `null` on a cache miss
   * or if the stored value is malformed.
   *
   * @param instanceId - The instance UUID to look up.
   * @returns The cached instance, or `null`.
   */
  async getCachedInstance(instanceId: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_ID(instanceId));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Retrieves a cached instance by its cluster ID and tag combination.
   *
   * @param clusterId - The cluster the instance belongs to.
   * @param tag - The unique tag identifying the instance within the cluster.
   * @returns The cached instance, or `null` on a miss.
   */
  async getCachedInstanceByName({ clusterId, tag }: { clusterId: string; tag: string }): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_NAME(clusterId, tag));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Retrieves a cached instance by tag alone, without knowing the cluster.
   * Used by the WebSocket node handler when an instance connects.
   *
   * @param tag - The instance tag to look up.
   * @returns The cached instance, or `null` on a miss.
   */
  async getCachedInstanceByTag(tag: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_TAG(tag));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Invalidates the cached entries for an instance. Always deletes the ID-keyed
   * entry. Deletes the cluster+tag and tag-only entries when the corresponding
   * identifiers are supplied.
   *
   * @param instanceId - The UUID of the instance to evict.
   * @param clusterId - Optional cluster ID, required to evict the name-keyed entry.
   * @param tag - Optional tag, required to evict both the name-keyed and
   *   tag-only entries.
   */
  async invalidateInstanceCache({ instanceId, clusterId, tag }: { instanceId: string; clusterId?: string; tag?: string }): Promise<void> {
    const deletes: Promise<void>[] = [this.kv.delete(KV_KEYS.INSTANCE_BY_ID(instanceId))];

    if (clusterId && tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE_BY_NAME(clusterId, tag)));
    }

    if (tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE_BY_TAG(tag)));
    }

    await Promise.all(deletes);
  }

  /**
   * Caches the full list of services for an instance with a short 60-second TTL.
   * Overwritten on each sync from the daemon's update payload.
   *
   * @param instanceId - The UUID of the instance whose services to cache.
   * @param services - The current list of services running on that instance.
   */
  async cacheServices(instanceId: string, services: Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }>): Promise<void> {
    const data = JSON.stringify(services);
    await this.kv.put(KV_KEYS.SERVICES(instanceId), data, { ttl: 60 });
  }

  /**
   * Retrieves the cached service list for an instance. Returns `null` on a miss
   * or if the cached data cannot be parsed.
   *
   * @param instanceId - The UUID of the instance to look up.
   * @returns An array of service objects, or `null`.
   */
  async getCachedServices(instanceId: string): Promise<Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }> | null> {
    try {
      const data = await this.kv.get(KV_KEYS.SERVICES(instanceId));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Evicts the service cache for an instance. Called after any write that
   * changes the service list (create, delete).
   *
   * @param instanceId - The UUID of the instance whose service cache to clear.
   */
  async invalidateServiceCache(instanceId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.SERVICES(instanceId));
  }

  /**
   * Saves a point-in-time process snapshot from the daemon's `top` output.
   * Keyed by instance ID and current timestamp so snapshots accumulate over
   * time and can be queried by range. Expires after 2 hours.
   *
   * @param instanceId - The instance the snapshot belongs to.
   * @param seq - The sequence number from the daemon update message.
   * @param snapshot - The raw process list data from the daemon.
   */
  async saveProcessSnapshot({ instanceId, seq, snapshot }: { instanceId: string; seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    const timestamp = Date.now();
    const key = KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp);
    await this.kv.put(key, JSON.stringify({ seq, timestamp, data: snapshot }), {
      ttl: 60 * 60 * 2,
    });
  }

  /**
   * Retrieves a single process snapshot by instance ID and exact timestamp.
   *
   * @param instanceId - The instance to look up.
   * @param timestamp - The exact millisecond timestamp used as the key.
   * @returns The snapshot data object, or `null` if not found.
   */
  async getProcessSnapshot({ instanceId, timestamp }: { instanceId: string; timestamp: number }): Promise<Record<string, unknown> | null> {
    const key = KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp);
    const data = await this.kv.get(key);
    if (!data) return null;
    const parsed = JSON.parse(data);
    return parsed.data;
  }

  /**
   * Returns the most recent process snapshots for an instance, up to `limit`
   * entries (capped at 1000). Results are sorted newest-first.
   *
   * @param instanceId - The instance to retrieve snapshots for.
   * @param limit - Maximum number of snapshots to return. Defaults to 10.
   * @returns An array of `{ seq, timestamp, data }` objects.
   */
  async getLatestProcessSnapshots({ instanceId, limit = 10 }: { instanceId: string; limit?: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const prefix = `process:${instanceId}:snapshot:`;
    const maxLimit = Math.min(limit, 1000);
    const result = await this.kv.list({ prefix, limit: maxLimit });

    const snapshots = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const timestampMatch = key.name.match(/:snapshot:(\d+)$/);
        if (!timestampMatch) return null;
        try {
          const parsed = JSON.parse(data);
          return {
            seq: parsed.seq,
            timestamp: parseInt(timestampMatch[1], 10),
            data: parsed.data,
          };
        } catch {
          return null;
        }
      }),
    );

    return snapshots
      .filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxLimit);
  }

  /**
   * Returns all process snapshots for an instance within a time range, sorted
   * oldest-first (ascending) for timeline rendering. The range is capped at a
   * maximum of 1 hour regardless of the supplied `endTime`.
   *
   * @param instanceId - The instance to query.
   * @param startTime - Range start in Unix milliseconds.
   * @param endTime - Range end in Unix milliseconds (capped to startTime + 1h).
   * @returns An array of `{ seq, timestamp, data }` objects, sorted ascending.
   */
  async getProcessSnapshotsByTimeRange({ instanceId, startTime, endTime }: { instanceId: string; startTime: number; endTime: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const maxRange = 60 * 60 * 1000;
    const cappedEndTime = Math.min(endTime, startTime + maxRange);

    const prefix = `process:${instanceId}:snapshot:`;
    const result = await this.kv.list({ prefix, limit: 10000 });

    const snapshots = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const timestampMatch = key.name.match(/:snapshot:(\d+)$/);
        if (!timestampMatch) return null;
        const timestamp = parseInt(timestampMatch[1], 10);

        if (timestamp < startTime || timestamp > cappedEndTime) return null;

        try {
          const parsed = JSON.parse(data);
          return {
            seq: parsed.seq,
            timestamp,
            data: parsed.data,
          };
        } catch {
          return null;
        }
      }),
    );

    return snapshots.filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null).sort((a, b) => a.timestamp - b.timestamp);
  }

  // ---------------------------------------------------------------------------
  // Admin JWT
  // ---------------------------------------------------------------------------

  /**
   * Issues a signed RS256 JWT for an admin session with a 30-minute expiry.
   * The token payload contains `sub` (sessionId) and `type: "admin"`.
   *
   * @param sessionId - The admin session identifier to embed as `sub`.
   * @param ttl - Unused parameter kept for API compatibility.
   * @returns A signed JWT string.
   */
  async createAdminJWT({ sessionId, ttl }: { sessionId: string; ttl?: number }): Promise<string> {
    const privateKey = await this.getPrivateKey();
    const payload = {
      sub: sessionId,
      type: "admin",
    };
    return await new SignJWT(payload).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setExpirationTime("30m").sign(privateKey);
  }

  /**
   * Retrieves a stored admin JWT for a session. Returns `null` if the token is
   * missing or would expire within the next `ADMIN_JWT_REFRESH_THRESHOLD`
   * seconds (29.5 minutes), prompting the caller to issue a fresh one.
   *
   * @param sessionId - The admin session ID to look up.
   * @returns The JWT string, or `null` if absent or near expiry.
   */
  async getAdminJWT(sessionId: string): Promise<string | null> {
    const data = await this.kv.get(KV_KEYS.ADMIN_JWT(sessionId));
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      const expiresAt = parsed.expiresAt;
      const now = Date.now();
      if (expiresAt - now < ADMIN_JWT_REFRESH_THRESHOLD * 1000) {
        return null;
      }
      return parsed.token;
    } catch {
      return null;
    }
  }

  /**
   * Stores an admin JWT alongside its expiry timestamp so near-expiry checks
   * can be done without decoding the token on every request. Expires from KV
   * after `ttl` seconds (default `ADMIN_JWT_TTL` = 30 minutes).
   *
   * @param sessionId - The admin session the token belongs to.
   * @param token - The signed JWT string to store.
   * @param ttl - How long to keep the entry in KV, in seconds.
   */
  async saveAdminJWT({ sessionId, token, ttl = ADMIN_JWT_TTL }: { sessionId: string; token: string; ttl?: number }): Promise<void> {
    const expiresAt = Date.now() + ttl * 1000;
    await this.kv.put(`admin_jwt:${sessionId}`, JSON.stringify({ token, expiresAt }), { ttl });
  }

  /**
   * Returns the full free instance pool array from KV. The pool is written from
   * config on startup and mutated at runtime via admin API endpoints (pause,
   * resume, remove).
   *
   * @returns An array of `FreeInstanceEntry` objects, or `null` if the pool has
   *   not been seeded yet.
   */
  async getFreeInstancePool(): Promise<FreeInstanceEntry[] | null> {
    const data = await this.kv.get(KV_KEYS.FREE_INSTANCE_POOL);
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Overwrites the free instance pool in KV. Used by the admin seed endpoint
   * and by pause/resume/remove operations that mutate the pool array.
   *
   * @param pool - The new pool array to persist.
   */
  async setFreeInstancePool(pool: FreeInstanceEntry[]): Promise<void> {
    await this.kv.put(KV_KEYS.FREE_INSTANCE_POOL, JSON.stringify(pool));
  }

  /**
   * Assigns a free instance to a cluster using a round-robin counter across
   * active pool entries. Skips instances with `status: "paused"`. The counter
   * is stored as a separate KV key and wraps around when it reaches the end
   * of the available pool.
   *
   * Capacity enforcement: an instance is skipped if its Redis counter
   * (`FREE_INSTANCE_COUNTER:{id}`) is at or above its configured `capacity`.
   * The counter is incremented atomically via `INCR` (Redis) to minimise race
   * conditions under concurrent signups.
   *
   * @param clusterId - The cluster to assign a free instance to.
   * @returns The assigned instance ID, or `null` if the pool is empty or all
   *   instances are paused / at capacity.
   */
  async assignFreeInstance(clusterId: string): Promise<string | null> {
    const pool = await this.getFreeInstancePool();
    if (!pool || pool.length === 0) return null;

    const available = pool.filter((inst) => inst.status !== "paused");
    if (available.length === 0) return null;

    let counter = 0;
    const counterKey = KV_KEYS.FREE_INSTANCE_COUNTER("global");
    const counterValue = await this.kv.get(counterKey);
    if (counterValue) {
      counter = parseInt(counterValue, 10) || 0;
    }

    counter = (counter + 1) % available.length;

    await this.kv.put(counterKey, counter.toString());

    const instance = available[counter];

    await this.kv.put(KV_KEYS.FREE_INSTANCE_CLUSTER(clusterId), instance.id);

    return instance.id;
  }

  /**
   * Returns the ID of the free instance currently assigned to a cluster, or
   * `null` if the cluster has not been assigned one (e.g. paid plan or pool
   * was empty at signup).
   *
   * @param clusterId - The cluster to look up.
   * @returns The assigned free instance ID, or `null`.
   */
  async getClusterFreeInstance(clusterId: string): Promise<string | null> {
    return await this.kv.get(KV_KEYS.FREE_INSTANCE_CLUSTER(clusterId));
  }

  /**
   * Removes the free instance assignment for a cluster. Called when a cluster
   * upgrades away from the hobby plan or when the assigned instance is removed
   * from the pool via the admin API.
   *
   * Does not decrement the instance counter — use the /admin API to manage
   * pool capacity manually when removing instances.
   *
   * @param clusterId - The cluster whose free instance assignment to release.
   */
  async releaseFreeInstance(clusterId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.FREE_INSTANCE_CLUSTER(clusterId));
  }

  /**
   * Scans all `free_instance:cluster:*` keys and returns a map of every
   * cluster ID to its currently assigned free instance ID. Used by the admin
   * API when removing an instance from the pool to find all affected clusters.
   *
   * @returns An array of `{ clusterId, instanceId }` pairs.
   */
  async getClustersFreeInstanceMap(): Promise<Array<{ clusterId: string; instanceId: string }>> {
    const prefix = "free_instance:cluster:";
    const keys = await this.kv.list({ prefix });
    const results = await Promise.all(
      keys.map(async (key) => {
        const instanceId = await this.kv.get(key.name);
        if (!instanceId) return null;
        const clusterId = key.name.slice(prefix.length);
        return { clusterId, instanceId };
      }),
    );
    return results.filter((r): r is { clusterId: string; instanceId: string } => r !== null);
  }
}