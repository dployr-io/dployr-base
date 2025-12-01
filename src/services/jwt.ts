// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { SignJWT, jwtVerify } from 'jose';
import { KVStore } from '@/lib/db/store/kv';
import { Session } from '@/types';

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
    const publicKeyJwk = await this.keyStore.getPublicKey();

    const nonce = crypto.randomUUID();

    return await new SignJWT({
      instance_id: instanceId,
      token_type: 'bootstrap',
      nonce,
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: (publicKeyJwk as any).kid as string,
      })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);
  }

  /**
   * Re-issues a bootstrap token for an existing nonce, typically used for
   * short-lived rotation while preserving the original nonce record.
   */
  async rotateBootstrapToken(
    instanceId: string,
    nonce: string,
    expiresIn: string = '5m',
  ): Promise<string> {
    const privateKey = await this.keyStore.getPrivateKey();
    const publicKeyJwk = await this.keyStore.getPublicKey();

    return await new SignJWT({
      instance_id: instanceId,
      token_type: 'bootstrap',
      nonce,
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: (publicKeyJwk as any).kid as string,
      })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  async createInstanceAccessToken(
    session: Session,
    instanceId: string,
    userRole: string,
    options?: { issuer?: string; audience?: string },
  ): Promise<string> {
    const privateKey = await this.keyStore.getPrivateKey();
    const publicKeyJwk = await this.keyStore.getPublicKey();

    let jwt = new SignJWT({
      sub: session.userId,
      instance_id: instanceId,
      perm: userRole,
      scopes: ['system.status'],
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: (publicKeyJwk as any).kid as string,
      })
      .setIssuedAt()
      .setExpirationTime('5m');

    if (options?.issuer) {
      jwt = jwt.setIssuer(options.issuer);
    }
    if (options?.audience) {
      jwt = jwt.setAudience(options.audience);
    }

    return await jwt.sign(privateKey);
  }

  /**
   * Creates a short-lived access token for an instance agent to call
   * /v1/agent endpoints. This does not depend on a user session.
   */
  async createAgentAccessToken(
    instanceId: string,
    options?: { issuer?: string; audience?: string },
  ): Promise<string> {
    const privateKey = await this.keyStore.getPrivateKey();
    const publicKeyJwk = await this.keyStore.getPublicKey();

    let jwt = new SignJWT({
      instance_id: instanceId,
      token_type: 'agent',
      perm: 'agent',
      scopes: ['agent.status', 'agent.tasks'],
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: (publicKeyJwk as any).kid as string,
      })
      .setIssuedAt()
      .setExpirationTime('5m');

    if (options?.issuer) {
      jwt = jwt.setIssuer(options.issuer);
    }
    if (options?.audience) {
      jwt = jwt.setAudience(options.audience);
    }

    return await jwt.sign(privateKey);
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

  /**
   * Verifies the token signature but ignores expiry.
   * Useful for token rotation where we want to accept expired tokens.
   * @param token - The token to verify.
   * @returns A promise that resolves to the token's payload.
   */
  async verifyTokenIgnoringExpiry(token: string) {
    const publicKeyJwk = await this.keyStore.getPublicKey();
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const { payload } = await jwtVerify(token, publicKey, {
      clockTolerance: Infinity, // Ignore expiry entirely
    });
    return payload;
  }
}