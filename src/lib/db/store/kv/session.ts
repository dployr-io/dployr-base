import { Session, User } from "@/types/index.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv-keys.js";
import {
  OTP_TTL,
  SESSION_TTL,
  STATE_TTL,
} from "@/lib/constants/index.js";

/**
 * Session-related KV operations: auth sessions, OTP, OAuth state.
 */
export class SessionStore {
  constructor(private kv: IKVAdapter) {}

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
}
