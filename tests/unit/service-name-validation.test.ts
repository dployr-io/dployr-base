// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateString } from "@/lib/validators/string-sanitizer.js";

describe("service name validation", () => {
  it("rejects high-risk names even when obfuscated", () => {
    const blocked = ["zooom-boko-haram-44", "b0k0-hVrVm-44"];

    for (const name of blocked) {
      const result = validateString(name, "name");
      assert.equal(result.valid, false, name);
      assert.match(result.error ?? "", /violates our policy/);
    }
  });

  it("rejects crypto scam service names", () => {
    const blocked = [
      "c0inbase-airdr0p-claim",
      "claim-reward-walletconnect",
      "seed-phrase-verify",
      "crypto-recovery-agent",
    ];

    for (const name of blocked) {
      assert.equal(validateString(name, "name").valid, false, name);
    }
  });

  it("accepts ordinary slug names", () => {
    const allowed = ["zooom-photo-service-44", "image-renderer", "kvngcache", "23rodeo"];

    for (const name of allowed) {
      assert.equal(validateString(name, "name").valid, true, name);
    }
  });

  it("rejects invalid slug", () => {
    const notAllowed = [undefined, "", "a", "-fotos", "fotos-", "api--worker", "333", "haystack!", "r@yband"];

    for (const name of notAllowed) {
      assert.equal(validateString(name, "name").valid, false, name);
    }
  });
});
