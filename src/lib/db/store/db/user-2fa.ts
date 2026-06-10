// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "crypto";
import { BaseStore } from "./base.js";
import { EncryptionService } from "@/lib/crypto/encryption.js";

export type TwoFaMethod = "email" | "totp";

export interface UserTwoFa {
  userId: string;
  method: TwoFaMethod;
  totpEnabled: boolean;
  updatedAt: number;
}

type UserTwoFaRow = {
  user_id: string;
  method: TwoFaMethod;
  totp_secret: Buffer | null;
  totp_secret_dek: Buffer | null;
  backup_codes: string[];
  updated_at: number;
};

function hashCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase()).digest("hex");
}

function generateBackupCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () =>
    Array.from({ length: 5 }, () => chars[randomBytes(1)[0] % chars.length]).join("");
  return `${part()}-${part()}`;
}

export class UserTwoFaStore extends BaseStore {
  protected readonly storeTable = "user_2fa" as const;

  constructor(
    db: ConstructorParameters<typeof BaseStore>[0],
    private encryption: EncryptionService,
  ) {
    super(db);
  }

  async find(userId: string): Promise<UserTwoFa | null> {
    const row = await this.db
      .prepare("SELECT user_id, method, totp_secret, updated_at FROM user_2fa WHERE user_id = $1")
      .bind(userId)
      .first<UserTwoFaRow>();

    if (!row) return null;
    return {
      userId: row.user_id,
      method: row.method,
      totpEnabled: row.method === "totp" && row.totp_secret != null,
      updatedAt: Number(row.updated_at),
    };
  }

  async getDecryptedTOTPSecret(userId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT totp_secret, totp_secret_dek FROM user_2fa WHERE user_id = $1")
      .bind(userId)
      .first<UserTwoFaRow>();

    if (!row || !row.totp_secret || !row.totp_secret_dek) return null;
    return this.encryption.decrypt(row.totp_secret, row.totp_secret_dek);
  }

  /** Ensures a user_2fa row exists with method='email'. Called lazily on first 2FA operation. */
  async ensureEmailRecord(userId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_2fa (user_id, method, updated_at)
         VALUES ($1, 'email', $2)
         ON CONFLICT (user_id) DO NOTHING`,
      )
      .bind(userId, this.now())
      .run();
  }

  /** Saves an encrypted TOTP secret and switches the method to 'totp'. Returns the 8 backup codes (plaintext, shown once). */
  async enableTOTP(userId: string, totpSecret: string): Promise<string[]> {
    const { valueCipher, dekCipher } = this.encryption.encrypt(totpSecret);
    const codes = Array.from({ length: 8 }, generateBackupCode);
    const hashes = codes.map(hashCode);

    await this.db
      .prepare(
        `INSERT INTO user_2fa (user_id, method, totp_secret, totp_secret_dek, backup_codes, updated_at)
         VALUES ($1, 'totp', $2, $3, $4::jsonb, $5)
         ON CONFLICT (user_id) DO UPDATE SET
           method = 'totp',
           totp_secret = EXCLUDED.totp_secret,
           totp_secret_dek = EXCLUDED.totp_secret_dek,
           backup_codes = EXCLUDED.backup_codes,
           updated_at = EXCLUDED.updated_at`,
      )
      .bind(userId, valueCipher, dekCipher, JSON.stringify(hashes), this.now())
      .run();

    return codes;
  }

  /** Reverts the user to email-based 2FA, wiping TOTP secret and backup codes. */
  async disableTOTP(userId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE user_2fa SET method = 'email', totp_secret = NULL, totp_secret_dek = NULL, backup_codes = '[]'::jsonb, updated_at = $2
         WHERE user_id = $1`,
      )
      .bind(userId, this.now())
      .run();
  }

  /**
   * Tries to consume a backup code. Returns true and removes it from the list if valid.
   * The code is case-insensitive and dash-insensitive.
   */
  async consumeBackupCode(userId: string, rawCode: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT backup_codes FROM user_2fa WHERE user_id = $1")
      .bind(userId)
      .first<{ backup_codes: string[] }>();

    if (!row || !row.backup_codes?.length) return false;

    const normalized = rawCode.replace(/-/g, "").toUpperCase();
    const targetHash = createHash("sha256").update(normalized).digest("hex");

    // Try both with and without separator since user may or may not type the dash
    const codeHashWithDash = hashCode(rawCode);
    const matchIdx = row.backup_codes.findIndex(
      (h) => h === targetHash || h === codeHashWithDash,
    );

    if (matchIdx === -1) return false;

    const updated = [...row.backup_codes];
    updated.splice(matchIdx, 1);

    await this.db
      .prepare("UPDATE user_2fa SET backup_codes = $2::jsonb, updated_at = $3 WHERE user_id = $1")
      .bind(userId, JSON.stringify(updated), this.now())
      .run();

    return true;
  }

  /** Regenerates backup codes. Returns the new plaintext codes. */
  async regenerateBackupCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 8 }, generateBackupCode);
    const hashes = codes.map(hashCode);

    await this.db
      .prepare("UPDATE user_2fa SET backup_codes = $2::jsonb, updated_at = $3 WHERE user_id = $1")
      .bind(userId, JSON.stringify(hashes), this.now())
      .run();

    return codes;
  }

  remainingBackupCodeCount = async (userId: string): Promise<number> => {
    const row = await this.db
      .prepare("SELECT backup_codes FROM user_2fa WHERE user_id = $1")
      .bind(userId)
      .first<{ backup_codes: string[] }>();
    return row?.backup_codes?.length ?? 0;
  };
}
