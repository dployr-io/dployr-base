// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";

export class BootstrapTokenStore extends BaseStore {
  async create(instanceId: string, nonce: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO bootstrap_tokens (instance_id, nonce) VALUES ($1, $2)`)
      .bind(instanceId, nonce)
      .run();
  }

  async markUsed(nonce: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE bootstrap_tokens 
         SET used_at = $1 
         WHERE nonce = $2 AND used_at IS NULL`
      )
      .bind(this.now(), nonce)
      .run();

    return result.meta.changes > 0;
  }

  async isUsed(nonce: string): Promise<boolean> {
    const token = await this.db
      .prepare(`SELECT used_at FROM bootstrap_tokens WHERE nonce = $1`)
      .bind(nonce)
      .first();

    return token ? token.used_at !== null : true;
  }
}