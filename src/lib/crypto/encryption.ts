// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts `plaintext` with a fresh random DEK using AES-256-GCM.
 * Returns the ciphertext and the raw DEK so the caller can wrap it separately.
 */
function encryptWithDek(plaintext: Buffer, dek: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, dek, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv (12) | tag (16) | ciphertext
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptWithDek(blob: Buffer, dek: Buffer): Buffer {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALG, dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class EncryptionService {
  private kek: Buffer;

  constructor(hexKey: string) {
    const key = Buffer.from(hexKey, "hex");
    if (key.length !== KEY_BYTES) {
      throw new Error(`Encryption key must be 32 bytes (64 hex chars); got ${key.length}`);
    }
    this.kek = key;
  }

  /** Encrypts a plaintext value. Returns `{ valueCipher, dekCipher }` to be stored in the DB. */
  encrypt(plaintext: string): { valueCipher: Buffer; dekCipher: Buffer } {
    const dek = randomBytes(KEY_BYTES);
    const valueCipher = encryptWithDek(Buffer.from(plaintext, "utf8"), dek);
    const dekCipher = encryptWithDek(dek, this.kek);
    return { valueCipher, dekCipher };
  }

  /** Decrypts a stored `{ valueCipher, dekCipher }` pair back to plaintext. */
  decrypt(valueCipher: Buffer, dekCipher: Buffer): string {
    const dek = decryptWithDek(dekCipher, this.kek);
    return decryptWithDek(valueCipher, dek).toString("utf8");
  }

  /** Re-encrypts all DEKs with a new KEK — call this during key rotation. */
  static rewrap(records: { dekCipher: Buffer }[], oldKey: string, newKey: string): Buffer[] {
    const oldSvc = new EncryptionService(oldKey);
    const newSvc = new EncryptionService(newKey);
    return records.map(({ dekCipher }) => {
      const dek = decryptWithDek(dekCipher, oldSvc.kek);
      return encryptWithDek(dek, newSvc.kek);
    });
  }
}
