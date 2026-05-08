// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSecret, maskBlueprintSecrets } from "@/lib/crypto/masking.js";

describe("maskSecret", () => {
  it("always outputs exactly 10 characters for values >= 2 chars", () => {
    for (const val of ["ab", "abc", "abcdefg", "averylongsecretvalue"]) {
      assert.equal(maskSecret(val).length, 10, `length check for "${val}"`);
    }
  });

  it("shows first 2 chars for values shorter than 7", () => {
    const result = maskSecret("abcde");
    assert.equal(result.slice(0, 2), "ab");
    assert.match(result, /^ab\*{8}$/);
  });

  it("shows first 3 chars for values 7 chars or longer", () => {
    const result = maskSecret("abcdefgh");
    assert.equal(result.slice(0, 3), "abc");
    assert.match(result, /^abc\*{7}$/);
  });

  it("masks do not reveal original length", () => {
    const short = maskSecret("hi");
    const long = maskSecret("this-is-a-very-long-secret-key-value");
    assert.equal(short.length, long.length);
  });
});

describe("maskBlueprintSecrets", () => {
  it("masks all values in secrets field", () => {
    const bp = { name: "app", secrets: { DB_PASS: "supersecret", API_KEY: "mykey123" } };
    const result = maskBlueprintSecrets(bp);
    assert.equal((result.secrets as any).DB_PASS.length, 10);
    assert.equal((result.secrets as any).API_KEY.length, 10);
  });

  it("leaves envVars untouched", () => {
    const bp = { envVars: { NODE_ENV: "production" }, secrets: { TOKEN: "abc1234" } };
    const result = maskBlueprintSecrets(bp);
    assert.equal((result.envVars as any).NODE_ENV, "production");
  });

  it("returns blueprint unchanged when secrets is absent", () => {
    const bp = { name: "no-secrets" };
    const result = maskBlueprintSecrets(bp);
    assert.deepEqual(result, bp);
  });

  it("returns blueprint unchanged when secrets is not an object", () => {
    const bp = { secrets: "not-an-object" } as any;
    const result = maskBlueprintSecrets(bp);
    assert.equal(result.secrets, "not-an-object");
  });

  it("does not mutate the original blueprint", () => {
    const bp = { secrets: { KEY: "original" } };
    maskBlueprintSecrets(bp);
    assert.equal(bp.secrets.KEY, "original");
  });
});
