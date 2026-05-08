// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeReturnTo, toISO, generateSecretKey, verifyGitHubWebhook } from "@/lib/utils.js";

describe("sanitizeReturnTo", () => {
  it("allows relative paths through unchanged", () => {
    assert.equal(sanitizeReturnTo("/dashboard"), "/dashboard");
    assert.equal(sanitizeReturnTo("/settings?tab=billing"), "/settings?tab=billing");
  });

  it("falls back to /dashboard for external URLs", () => {
    assert.equal(sanitizeReturnTo("https://evil.example.com/steal"), "/dashboard");
  });

  it("falls back to /dashboard for malformed input", () => {
    assert.equal(sanitizeReturnTo("not a url"), "/dashboard");
  });

  it("falls back to /dashboard for empty string", () => {
    assert.equal(sanitizeReturnTo(""), "/dashboard");
  });
});

describe("toISO", () => {
  it("converts a valid ms timestamp to ISO string", () => {
    const ts = 1_700_000_000_000;
    const result = toISO(ts);
    assert.equal(result, new Date(ts).toISOString());
  });

  it("converts a valid ISO string back to ISO string", () => {
    const iso = "2024-01-15T12:00:00.000Z";
    assert.equal(toISO(iso), iso);
  });

  it("returns a current ISO string for null", () => {
    const before = Date.now();
    const result = toISO(null);
    const after = Date.now();
    const parsed = new Date(result).getTime();
    assert.ok(parsed >= before && parsed <= after);
  });

  it("returns a current ISO string for undefined", () => {
    const before = Date.now();
    const result = toISO(undefined);
    const after = Date.now();
    const parsed = new Date(result).getTime();
    assert.ok(parsed >= before && parsed <= after);
  });

  it("returns a current ISO string for an invalid date string", () => {
    const before = Date.now();
    const result = toISO("not-a-date");
    const after = Date.now();
    const parsed = new Date(result).getTime();
    assert.ok(parsed >= before && parsed <= after);
  });
});

describe("generateSecretKey", () => {
  it("generates hex output of the correct length", () => {
    const key = generateSecretKey({ length: 32, encoding: "hex" });
    assert.equal(key.length, 64); // 32 bytes = 64 hex chars
    assert.match(key, /^[0-9a-f]+$/);
  });

  it("generates base64 output", () => {
    const key = generateSecretKey({ length: 16, encoding: "base64" });
    assert.ok(key.length > 0);
    // base64 chars only
    assert.match(key, /^[A-Za-z0-9+/=]+$/);
  });

  it("generates base64url output without +, /, or =", () => {
    const key = generateSecretKey({ length: 32, encoding: "base64url" });
    assert.ok(!key.includes("+") && !key.includes("/") && !key.includes("="));
  });

  it("each call produces a different key", () => {
    const a = generateSecretKey({ length: 32 });
    const b = generateSecretKey({ length: 32 });
    assert.notEqual(a, b);
  });
});

describe("verifyGitHubWebhook", () => {
  it("returns true for a valid signature", async () => {
    const secret = "webhook-secret";
    const payload = JSON.stringify({ action: "push" });

    // Compute expected HMAC using WebCrypto (same as implementation)
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const digest = "sha256=" + Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");

    assert.equal(await verifyGitHubWebhook({ payload, signature: digest, secret }), true);
  });

  it("returns false for a wrong signature", async () => {
    assert.equal(
      await verifyGitHubWebhook({ payload: "data", signature: "sha256=deadbeef", secret: "secret" }),
      false,
    );
  });

  it("returns false when secret is wrong", async () => {
    const payload = "data";
    const secret = "correct-secret";
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const digest = "sha256=" + Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, "0")).join("");

    assert.equal(await verifyGitHubWebhook({ payload, signature: digest, secret: "wrong-secret" }), false);
  });
});
