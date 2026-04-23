import { CryptoKey, importPKCS8, SignJWT } from "jose";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { generateKeyPair } from "@/lib/crypto/keystore.js";
import { ADMIN_JWT_TTL, ADMIN_JWT_REFRESH_THRESHOLD } from "@/lib/constants/index.js";
import { JsonWebKey } from "crypto";

/**
 * JWT key management and admin token operations.
 */
export class KeyStore {
  constructor(private kv: IKVAdapter) {}

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

  // Admin JWT
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
}
