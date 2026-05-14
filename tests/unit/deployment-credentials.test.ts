// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectToken } from "@/services/deployments.js";

describe("injectToken — git credential injection", () => {
  it("injects x-access-token for github.com URLs", () => {
    const result = injectToken("https://github.com/org/repo.git", "x-access-token", "ghp_abc");
    assert.equal(result, "https://x-access-token:ghp_abc@github.com/org/repo.git");
  });

  it("injects oauth2 for gitlab.com URLs", () => {
    const result = injectToken("https://gitlab.com/org/repo.git", "oauth2", "glpat-xyz");
    assert.equal(result, "https://oauth2:glpat-xyz@gitlab.com/org/repo.git");
  });

  it("injects x-token-auth for bitbucket.org URLs", () => {
    const result = injectToken("https://bitbucket.org/org/repo.git", "x-token-auth", "bbtoken");
    assert.equal(result, "https://x-token-auth:bbtoken@bitbucket.org/org/repo.git");
  });

  it("injects oauth2 for unknown HTTPS hosts", () => {
    const result = injectToken("https://git.company.internal/repo.git", "oauth2", "tok");
    assert.equal(result, "https://oauth2:tok@git.company.internal/repo.git");
  });

  it("normalises http:// to https:// before injecting", () => {
    const result = injectToken("http://github.com/org/repo.git", "x-access-token", "ghp_abc");
    assert.equal(result, "https://x-access-token:ghp_abc@github.com/org/repo.git");
  });

  it("returns URL unchanged when it already contains @", () => {
    const url = "https://user:pass@github.com/org/repo.git";
    assert.equal(injectToken(url, "x-access-token", "ghp_abc"), url);
  });

  it("returns SSH-style URL unchanged (cannot embed credentials)", () => {
    const url = "git@github.com:org/repo.git";
    assert.equal(injectToken(url, "x-access-token", "ghp_abc"), url);
  });

  it("returns non-http/https URLs unchanged", () => {
    const url = "ssh://git@github.com/org/repo.git";
    assert.equal(injectToken(url, "x-access-token", "ghp_abc"), url);
  });
});
