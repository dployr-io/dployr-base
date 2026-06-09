// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { TTL_1_HOUR } from "@/lib/constants/index.js";

const PREFIX = "oidc_jwks:";

export class JwksCacheStore {
  constructor(private kv: IKVAdapter) {}

  async get(issuer: string): Promise<{ keys: any[] } | null> {
    const raw = await this.kv.get(`${PREFIX}${this.key(issuer)}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async set(issuer: string, jwks: { keys: any[] }): Promise<void> {
    await this.kv.put(`${PREFIX}${this.key(issuer)}`, JSON.stringify(jwks), { ttl: TTL_1_HOUR });
  }

  private key(issuer: string): string {
    return issuer.replace(/[^a-zA-Z0-9]/g, "_");
  }
}
