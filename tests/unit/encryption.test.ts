// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EncryptionService } from "@/lib/crypto/encryption.js";

const validKey = "a".repeat(64); // 32 bytes as hex

describe("EncryptionService", () => {
  it("rejects a key that is not 32 bytes", () => {
    assert.throws(() => new EncryptionService("deadbeef"), /32 bytes/);
  });

  it("encrypt then decrypt roundtrips correctly", () => {
    const svc = new EncryptionService(validKey);
    const plaintext = "super-secret-value";
    const { valueCipher, dekCipher } = svc.encrypt(plaintext);
    assert.equal(svc.decrypt(valueCipher, dekCipher), plaintext);
  });

  it("produces different ciphertexts on each encrypt call (random IV/DEK)", () => {
    const svc = new EncryptionService(validKey);
    const { valueCipher: c1 } = svc.encrypt("same");
    const { valueCipher: c2 } = svc.encrypt("same");
    assert.notDeepEqual(c1, c2);
  });

  it("decrypt throws on tampered ciphertext", () => {
    const svc = new EncryptionService(validKey);
    const { valueCipher, dekCipher } = svc.encrypt("data");
    const tampered = Buffer.from(valueCipher);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => svc.decrypt(tampered, dekCipher));
  });

  it("decrypt throws on tampered DEK cipher", () => {
    const svc = new EncryptionService(validKey);
    const { valueCipher, dekCipher } = svc.encrypt("data");
    const tampered = Buffer.from(dekCipher);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => svc.decrypt(valueCipher, tampered));
  });

  it("rewrap re-encrypts DEKs with new KEK and decryption still works", () => {
    const oldKey = "b".repeat(64);
    const newKey = "c".repeat(64);
    const oldSvc = new EncryptionService(oldKey);
    const newSvc = new EncryptionService(newKey);

    const plaintext = "rewrap-me";
    const { valueCipher, dekCipher } = oldSvc.encrypt(plaintext);

    const [newDekCipher] = EncryptionService.rewrap([{ dekCipher }], oldKey, newKey);
    assert.equal(newSvc.decrypt(valueCipher, newDekCipher), plaintext);
  });

  it("rewrap with wrong old key throws", () => {
    const oldKey = "b".repeat(64);
    const wrongKey = "d".repeat(64);
    const newKey = "c".repeat(64);
    const oldSvc = new EncryptionService(oldKey);
    const { dekCipher } = oldSvc.encrypt("x");
    assert.throws(() => EncryptionService.rewrap([{ dekCipher }], wrongKey, newKey));
  });
});
