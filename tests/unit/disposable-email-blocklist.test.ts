// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isDisposableEmail, _resetCache } from "@/lib/email/blocklist.js";

const BLOCKLIST = ["mailinator.com", "guerrillamail.com", "throwam.com"].join("\n");

function mockFetch(response: { ok: boolean; text?: string }) {
  return mock.method(globalThis, "fetch", async () => ({
    ok: response.ok,
    status: response.ok ? 200 : 500,
    text: async () => response.text ?? "",
  }));
}

beforeEach(() => {
  mock.restoreAll();
  _resetCache();
});

describe("isDisposableEmail", () => {
  it("returns true for a known disposable domain", async () => {
    mockFetch({ ok: true, text: BLOCKLIST });
    assert.equal(await isDisposableEmail("bot@mailinator.com"), true);
  });

  it("returns false for a legitimate domain", async () => {
    mockFetch({ ok: true, text: BLOCKLIST });
    assert.equal(await isDisposableEmail("user@acme.org"), false);
  });

  it("returns false for a gmail address", async () => {
    mockFetch({ ok: true, text: BLOCKLIST });
    assert.equal(await isDisposableEmail("user@gmail.com"), false);
  });

  it("returns false when the blocklist fetch fails (fail open)", async () => {
    mockFetch({ ok: false });
    assert.equal(await isDisposableEmail("bot@mailinator.com"), false);
  });

  it("returns false for a malformed email with no domain", async () => {
    mockFetch({ ok: true, text: BLOCKLIST });
    assert.equal(await isDisposableEmail("nodomain"), false);
  });

  it("is case-insensitive on the domain", async () => {
    mockFetch({ ok: true, text: BLOCKLIST });
    assert.equal(await isDisposableEmail("bot@MAILINATOR.COM"), true);
  });

  it("uses cached result on second call without re-fetching", async () => {
    const fetchMock = mockFetch({ ok: true, text: BLOCKLIST });
    await isDisposableEmail("bot@mailinator.com");
    await isDisposableEmail("other@mailinator.com");
    assert.equal(fetchMock.mock.calls.length, 1, "fetch must only be called once");
  });
});
