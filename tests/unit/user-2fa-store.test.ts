// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { UserTwoFaStore } from "@/lib/db/store/db/user-2fa.js";
import { EncryptionService } from "@/lib/crypto/encryption.js";

const VALID_KEY = "a".repeat(64); // 32 bytes as hex

function hashCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase()).digest("hex");
}

/**
 * Minimal mock DB that holds a single user_2fa row and tracks state mutations.
 * Supports the prepare().bind().first() / .run() chain used by UserTwoFaStore.
 */
function makeMockDb(initialCodes: string[]) {
  let storedCodes = [...initialCodes];

  const db = {
    get storedCodes() { return storedCodes; },
    prepare(sql: string) {
      const isUpdate = sql.trimStart().toUpperCase().startsWith("UPDATE");
      return {
        bind(...args: any[]) {
          return {
            async first<T>() {
              return { backup_codes: storedCodes } as T;
            },
            async run() {
              if (isUpdate) {
                // args: [userId, JSON.stringify(updatedCodes), timestamp]
                storedCodes = JSON.parse(args[1]) as string[];
              }
            },
          };
        },
      };
    },
  };

  return db;
}

function makeStore(codes: string[]) {
  const db = makeMockDb(codes);
  const encryption = new EncryptionService(VALID_KEY);
  const store = new UserTwoFaStore(db as any, encryption);
  return { store, db };
}

const TEST_USER = "user-123";

// ── consumeBackupCode ─────────────────────────────────────────────────────────

describe("UserTwoFaStore.consumeBackupCode", () => {
  it("returns false when backup_codes is empty", async () => {
    const { store } = makeStore([]);
    const result = await store.consumeBackupCode(TEST_USER, "AAAAA-BBBBB");
    assert.equal(result, false);
  });

  it("returns false for an unknown code", async () => {
    const storedHash = hashCode("ZZZZZ-YYYYY");
    const { store } = makeStore([storedHash]);
    const result = await store.consumeBackupCode(TEST_USER, "AAAAA-BBBBB");
    assert.equal(result, false);
  });

  it("returns true for a valid code (with dash)", async () => {
    const code = "AAAAA-BBBBB";
    const storedHash = hashCode(code);
    const { store } = makeStore([storedHash]);
    const result = await store.consumeBackupCode(TEST_USER, code);
    assert.equal(result, true);
  });

  it("removes the code from storage after successful consumption", async () => {
    const code = "CCCCC-DDDDD";
    const storedHash = hashCode(code);
    const { store, db } = makeStore([storedHash]);

    await store.consumeBackupCode(TEST_USER, code);

    assert.equal(db.storedCodes.length, 0, "Code should be removed from storage");
  });

  it("only removes the matched code, leaving others intact", async () => {
    const code = "EEEEE-FFFFF";
    const other = "GGGGG-HHHHH";
    const { store, db } = makeStore([hashCode(code), hashCode(other)]);

    await store.consumeBackupCode(TEST_USER, code);

    assert.equal(db.storedCodes.length, 1, "Only one code should remain");
    assert.equal(db.storedCodes[0], hashCode(other), "Remaining code should be the unused one");
  });

  it("returns false on second use of the same code (single-use enforcement)", async () => {
    const code = "IIIII-JJJJJ";
    const { store } = makeStore([hashCode(code)]);

    const first = await store.consumeBackupCode(TEST_USER, code);
    const second = await store.consumeBackupCode(TEST_USER, code);

    assert.equal(first, true, "First use should succeed");
    assert.equal(second, false, "Second use should be rejected");
  });

  it("is case-insensitive (lowercase input matches uppercase stored hash)", async () => {
    const code = "AAAAA-BBBBB";
    const storedHash = hashCode(code);
    const { store } = makeStore([storedHash]);

    const result = await store.consumeBackupCode(TEST_USER, code.toLowerCase());
    assert.equal(result, true);
  });

  it("handles multiple codes and consumes them one at a time", async () => {
    const codes = ["AAAAA-BBBBB", "CCCCC-DDDDD", "EEEEE-FFFFF"];
    const { store, db } = makeStore(codes.map(hashCode));

    for (let i = 0; i < codes.length; i++) {
      const result = await store.consumeBackupCode(TEST_USER, codes[i]);
      assert.equal(result, true, `Code ${i} should succeed`);
      assert.equal(db.storedCodes.length, codes.length - (i + 1), `Should have ${codes.length - (i + 1)} codes remaining`);
    }

    assert.equal(db.storedCodes.length, 0, "All codes should be consumed");
  });
});

// ── remainingBackupCodeCount ──────────────────────────────────────────────────

describe("UserTwoFaStore.remainingBackupCodeCount", () => {
  it("returns 0 when no codes remain", async () => {
    const { store } = makeStore([]);
    const count = await store.remainingBackupCodeCount(TEST_USER);
    assert.equal(count, 0);
  });

  it("returns the number of stored codes", async () => {
    const { store } = makeStore([hashCode("AAAAA-BBBBB"), hashCode("BBBBB-CCCCC"), hashCode("CCCCC-DDDDD")]);
    const count = await store.remainingBackupCodeCount(TEST_USER);
    assert.equal(count, 3);
  });
});
