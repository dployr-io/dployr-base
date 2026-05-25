// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeHealthCheckPath } from "@/lib/utils.js";

describe("normalizeHealthCheckPath", () => {
  // Canonical form — no change
  it("returns /foo/bar unchanged", () => {
    assert.equal(normalizeHealthCheckPath("/foo/bar"), "/foo/bar");
  });

  it("returns / for bare slash", () => {
    assert.equal(normalizeHealthCheckPath("/"), "/");
  });

  // Form A — no leading slash
  it("prepends / to foo/bar", () => {
    assert.equal(normalizeHealthCheckPath("foo/bar"), "/foo/bar");
  });

  it("prepends / to health", () => {
    assert.equal(normalizeHealthCheckPath("health"), "/health");
  });

  // Form C — trailing slash
  it("strips trailing slash from /foo/bar/", () => {
    assert.equal(normalizeHealthCheckPath("/foo/bar/"), "/foo/bar");
  });

  it("strips multiple trailing slashes from /health///", () => {
    assert.equal(normalizeHealthCheckPath("/health///"), "/health");
  });

  // Combination of A + C
  it("handles no leading slash and trailing slash: foo/bar/", () => {
    assert.equal(normalizeHealthCheckPath("foo/bar/"), "/foo/bar");
  });

  // Null / empty
  it("returns / for null", () => {
    assert.equal(normalizeHealthCheckPath(null), "/");
  });

  it("returns / for undefined", () => {
    assert.equal(normalizeHealthCheckPath(undefined), "/");
  });

  it("returns / for empty string", () => {
    assert.equal(normalizeHealthCheckPath(""), "/");
  });

  it("returns / for whitespace-only string", () => {
    assert.equal(normalizeHealthCheckPath("   "), "/");
  });

  // Whitespace trimming
  it("trims surrounding whitespace before normalizing", () => {
    assert.equal(normalizeHealthCheckPath("  /health/check  "), "/health/check");
  });

  it("trims and prepends slash", () => {
    assert.equal(normalizeHealthCheckPath("  health  "), "/health");
  });
});
