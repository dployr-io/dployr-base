import { BaseStore } from "./base";

export class BootstrapTokenStore extends BaseStore {
  async create(instanceId: string, nonce: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO bootstrap_tokens (instance_id, nonce) VALUES (?, ?)`)
      .bind(instanceId, nonce)
      .run();
  }

  async markUsed(nonce: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE bootstrap_tokens 
         SET used_at = ? 
         WHERE nonce = ? AND used_at IS NULL`
      )
      .bind(this.now(), nonce)
      .run();

    return result.meta.changes > 0;
  }

  async isUsed(nonce: string): Promise<boolean> {
    const token = await this.db
      .prepare(`SELECT used_at FROM bootstrap_tokens WHERE nonce = ?`)
      .bind(nonce)
      .first();

    return token ? token.used_at !== null : true;
  }
}