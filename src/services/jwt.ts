import { SignJWT, jwtVerify } from 'jose';
import { KVStore } from '@/lib/db/store/kv';

/**
 * Service for creating and verifying JWT tokens.
 */
export class JWTService {
  /**
   * Creates a new JWTService instance.
   * @param keyStore - The key store to use for signing and verifying tokens.
   */
  constructor(private keyStore: KVStore) {}

  /**
   * Creates a new bootstrap token for the given instance ID.
   * @param instanceId - The ID of the instance to create the token for.
   * @returns A promise that resolves to the created token.
   */
  async createBootstrapToken(instanceId: string): Promise<string> {
    const privateKey = await this.keyStore.getPrivateKey();
    const nonce = crypto.randomUUID();

    return await new SignJWT({
      instance_id: instanceId,
      token_type: 'bootstrap',
      nonce,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);
  }

  /**
   * Verifies the given token and returns its payload.
   * @param token - The token to verify.
   * @returns A promise that resolves to the token's payload.
   */
  async verifyToken(token: string) {
    const publicKeyJwk = await this.keyStore.getPublicKey();
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const { payload } = await jwtVerify(token, publicKey);
    return payload;
  }
}