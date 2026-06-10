// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";

export function registerTwoFaTests(getFx: () => TestFixtures) {
  describe("2FA — status", () => {
    function auth(init: RequestInit = {}): RequestInit {
      return { ...init, headers: { "Content-Type": "application/json", Cookie: getFx().session, ...((init.headers as object) ?? {}) } };
    }

    it("GET /v1/auth/2fa/status rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/status`);
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("GET /v1/auth/2fa/status returns default email method", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/status`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.data.method, "email");
      assert.equal(body.data.totpEnabled, false);
      assert.equal(body.data.backupCodesRemaining, 0);
    });
  });

  describe("2FA — email OTP", () => {
    function auth(init: RequestInit = {}): RequestInit {
      return { ...init, headers: { "Content-Type": "application/json", Cookie: getFx().session, ...((init.headers as object) ?? {}) } };
    }

    it("POST /v1/auth/2fa/email/send rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/email/send`, { method: "POST", headers: { "Content-Type": "application/json" } });
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/email/send returns sent:true", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/email/send`, auth({ method: "POST" }));
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.data.sent, true);
    });

    it("POST /v1/auth/2fa/verify rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      });
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/verify rejects code shorter than 6 chars", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/verify`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({ code: "123" }),
      });
      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/verify rejects missing code", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/verify`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/verify accepts any code in test env and marks session verified", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/verify`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.data.verified, true);
    });
  });

  describe("2FA — TOTP full lifecycle", () => {
    function auth(init: RequestInit = {}): RequestInit {
      return { ...init, headers: { "Content-Type": "application/json", Cookie: getFx().session, ...((init.headers as object) ?? {}) } };
    }

    it("GET /v1/auth/2fa/totp/setup rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/setup`);
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("GET /v1/auth/2fa/totp/setup returns base32 secret and otpauth URI", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/setup`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(body.data.secret, "Expected secret");
      assert.match(body.data.secret, /^[A-Z2-7]+=*$/, "Secret should be base32");
      assert.ok(body.data.uri, "Expected uri");
      assert.match(body.data.uri, /^otpauth:\/\/totp\//, "URI should be otpauth://totp/");
    });

    it("POST /v1/auth/2fa/totp/confirm rejects non-6-digit code", async () => {
      // Trigger setup first so setup secret exists in KV
      await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/setup`, auth());

      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/confirm`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({ code: "12345" }),
      });
      assert.equal(res.status, 400, `Expected 400 for 5-digit code, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/totp/confirm rejects missing code", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/confirm`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/totp/confirm enables TOTP and returns 8 backup codes", async () => {
      // Setup first to populate KV setup secret
      await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/setup`, auth());

      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/confirm`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(Array.isArray(body.data.backupCodes), "Expected backupCodes array");
      assert.equal(body.data.backupCodes.length, 8, "Expected 8 backup codes");
      // Each code should match XXXXX-XXXXX format
      for (const code of body.data.backupCodes) {
        assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/, `Unexpected backup code format: ${code}`);
      }
    });

    it("GET /v1/auth/2fa/status shows totpEnabled:true after confirm", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/status`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(body.data.method, "totp");
      assert.equal(body.data.totpEnabled, true);
      assert.equal(body.data.backupCodesRemaining, 8);
    });

    it("POST /v1/auth/2fa/backup-codes/regenerate rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/backup-codes/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      });
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/backup-codes/regenerate returns 8 fresh backup codes in test env", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/backup-codes/regenerate`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(Array.isArray(body.data.backupCodes), "Expected backupCodes array");
      assert.equal(body.data.backupCodes.length, 8);
    });

    it("GET /v1/auth/2fa/status still shows 8 backup codes after regeneration", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/status`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(body.data.backupCodesRemaining, 8);
    });

    it("DELETE /v1/auth/2fa/totp rejects unauthenticated", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      });
      assert.ok([401, 403].includes(res.status), `Expected 401/403, got ${res.status}`);
    });

    it("DELETE /v1/auth/2fa/totp rejects invalid code format", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp`, {
        ...auth({ method: "DELETE" }),
        body: JSON.stringify({ code: "12" }),
      });
      assert.equal(res.status, 400, `Expected 400 for short code, got ${res.status}`);
    });

    it("DELETE /v1/auth/2fa/totp disables TOTP in test env", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp`, {
        ...auth({ method: "DELETE" }),
        body: JSON.stringify({ code: "123456" }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.data.disabled, true);
    });

    it("GET /v1/auth/2fa/status reverts to email method after TOTP disabled", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/status`, auth());
      const body = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(body.data.method, "email");
      assert.equal(body.data.totpEnabled, false);
      assert.equal(body.data.backupCodesRemaining, 0);
    });
  });

  describe("2FA — require2FA enforcement", () => {
    const LIMIT_EMAIL = "ci-limit-test@example.com";

    async function freshSession(baseUrl: string): Promise<string> {
      await fetch(`${baseUrl}/v1/auth/login/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: LIMIT_EMAIL }),
      });
      const verify = await fetch(`${baseUrl}/v1/auth/login/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: LIMIT_EMAIL, code: "000000" }),
      });
      const setCookie = verify.headers.get("set-cookie") ?? "";
      const match = setCookie.match(/session=([^;]+)/);
      if (!match) throw new Error("No session cookie in verify response");
      return `session=${match[1]}`;
    }

    function authWith(cookie: string, init: RequestInit = {}): RequestInit {
      return { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...((init.headers as object) ?? {}) } };
    }

    it("protected routes return 403 with auth.two_fa_required when TOTP enabled but session not verified", async () => {
      const { baseUrl, limitSession } = getFx();

      // Enable TOTP on the limit user (confirm marks limitSession as 2FA-verified).
      await fetch(`${baseUrl}/v1/auth/2fa/totp/setup`, authWith(limitSession));
      const confirmRes = await fetch(`${baseUrl}/v1/auth/2fa/totp/confirm`, {
        ...authWith(limitSession, { method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });
      assert.equal(confirmRes.status, 200, "Expected TOTP enable to succeed");

      // New login → fresh session with no twoFaVerifiedAt
      const unverified = await freshSession(baseUrl);

      // POST /v1/auth/tokens must be blocked
      const createRes = await fetch(`${baseUrl}/v1/auth/tokens`, {
        ...authWith(unverified, { method: "POST" }),
        body: JSON.stringify({ name: "test-token", scopes: ["oidc:bind"] }),
      });
      const createBody = (await createRes.json()) as any;
      assert.equal(createRes.status, 403, `Expected 403, got ${createRes.status}: ${JSON.stringify(createBody)}`);
      assert.equal(createBody.code, "auth.two_fa_required", `Expected auth.two_fa_required, got ${createBody.code}`);

      // Clean up — disable TOTP using the verified limitSession
      await fetch(`${baseUrl}/v1/auth/2fa/totp`, {
        ...authWith(limitSession, { method: "DELETE" }),
        body: JSON.stringify({ code: "123456" }),
      });
    });

    it("protected routes succeed after 2FA verification", async () => {
      const { baseUrl, limitSession } = getFx();

      // Re-enable TOTP on limit user
      await fetch(`${baseUrl}/v1/auth/2fa/totp/setup`, authWith(limitSession));
      await fetch(`${baseUrl}/v1/auth/2fa/totp/confirm`, {
        ...authWith(limitSession, { method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });

      // Fresh session, then verify 2FA
      const unverified = await freshSession(baseUrl);
      const verifyRes = await fetch(`${baseUrl}/v1/auth/2fa/verify`, {
        ...authWith(unverified, { method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });
      assert.equal(verifyRes.status, 200, "Expected verify to succeed");

      // Now the protected route should pass
      const createRes = await fetch(`${baseUrl}/v1/auth/tokens`, {
        ...authWith(unverified, { method: "POST" }),
        body: JSON.stringify({ name: "test-token", scopes: ["oidc:bind"] }),
      });
      assert.equal(createRes.status, 201, `Expected 201 after 2FA verify, got ${createRes.status}`);

      // Clean up
      await fetch(`${baseUrl}/v1/auth/2fa/totp`, {
        ...authWith(limitSession, { method: "DELETE" }),
        body: JSON.stringify({ code: "123456" }),
      });
    });

    it("API token sessions bypass require2FA", async () => {
      const { baseUrl, session } = getFx();

      // Create an API token using the main session (which has no TOTP, so no require2FA block)
      const tokenRes = await fetch(`${baseUrl}/v1/auth/tokens`, {
        ...authWith(session, { method: "POST" }),
        body: JSON.stringify({ name: "bypass-test-token", scopes: ["oidc:bind"] }),
      });
      assert.equal(tokenRes.status, 201, "Setup: token creation should succeed without TOTP");
      const { data: tokenData } = (await tokenRes.json()) as any;
      const apiToken: string = tokenData.token;

      // Enable TOTP on limit user
      await fetch(`${baseUrl}/v1/auth/2fa/totp/setup`, authWith(getFx().limitSession));
      await fetch(`${baseUrl}/v1/auth/2fa/totp/confirm`, {
        ...authWith(getFx().limitSession, { method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });

      // A Bearer API token (scoped) should NOT be blocked — scoped sessions skip require2FA
      // (In this case the token belongs to the main user who has no TOTP, but even if the
      // limit user had a scoped token, it would be exempt because scopes !== undefined.)
      const bearerRes = await fetch(`${baseUrl}/v1/auth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ name: "nested-token", scopes: ["oidc:bind"] }),
      });
      // Scoped tokens cannot create other tokens — so 403, but NOT auth.two_fa_required
      const bearerBody = (await bearerRes.json()) as any;
      assert.notEqual(bearerBody.code, "auth.two_fa_required", "API tokens must not be blocked by require2FA");

      // Revoke test token
      await fetch(`${baseUrl}/v1/auth/tokens/${tokenData.id}`, {
        ...authWith(session, { method: "DELETE" }),
      });

      // Disable TOTP on limit user
      await fetch(`${baseUrl}/v1/auth/2fa/totp`, {
        ...authWith(getFx().limitSession, { method: "DELETE" }),
        body: JSON.stringify({ code: "123456" }),
      });
    });
  });

  describe("2FA — TOTP precondition guards", () => {
    function auth(init: RequestInit = {}): RequestInit {
      return { ...init, headers: { "Content-Type": "application/json", Cookie: getFx().otherSession, ...((init.headers as object) ?? {}) } };
    }

    it("DELETE /v1/auth/2fa/totp returns error when TOTP is not enabled", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp`, {
        ...auth({ method: "DELETE" }),
        body: JSON.stringify({ code: "123456" }),
      });
      assert.ok([400, 404, 409].includes(res.status), `Expected 4xx for TOTP not enabled, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/backup-codes/regenerate returns error when TOTP is not enabled", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/backup-codes/regenerate`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });
      assert.ok([400, 404, 409].includes(res.status), `Expected 4xx for TOTP not enabled, got ${res.status}`);
    });

    it("POST /v1/auth/2fa/totp/confirm returns error when no setup secret exists", async () => {
      const res = await fetch(`${getFx().baseUrl}/v1/auth/2fa/totp/confirm`, {
        ...auth({ method: "POST" }),
        body: JSON.stringify({ code: "123456" }),
      });
      assert.equal(res.status, 400, `Expected 400 for missing setup secret, got ${res.status}`);
    });
  });
}
