// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mirrors the exact role-resolution logic inside JWTService.createInstanceAccessToken.
// If this function's behaviour ever changes, these tests must fail first.
function resolveClusterRole(
  session: { clusters: { id: string; role: string }[] },
  clusterId: string,
): string {
  const cluster = session.clusters.find((c) => c.id === clusterId);
  return cluster?.role || "user";
}

function makeSession(clusters: { id: string; role: string }[]) {
  return { userId: "user-1", clusters };
}

describe("resolveClusterRole — perm claim derivation for instance access tokens", () => {
  it("returns the user's actual role when clusterId matches", () => {
    const session = makeSession([{ id: "clus-abc", role: "developer" }]);
    assert.equal(resolveClusterRole(session, "clus-abc"), "developer");
  });

  it("returns 'owner' for an owner-role cluster membership", () => {
    const session = makeSession([{ id: "clus-abc", role: "owner" }]);
    assert.equal(resolveClusterRole(session, "clus-abc"), "owner");
  });

  it("picks the correct cluster when session has multiple clusters", () => {
    const session = makeSession([
      { id: "clus-abc", role: "developer" },
      { id: "clus-xyz", role: "owner" },
    ]);
    assert.equal(resolveClusterRole(session, "clus-abc"), "developer");
    assert.equal(resolveClusterRole(session, "clus-xyz"), "owner");
  });


  it('falls back to "user" when the string "owner" is passed as clusterId', () => {
    const session = makeSession([{ id: "clus-abc", role: "owner" }]);
    assert.equal(
      resolveClusterRole(session, "owner"),
      "user",
      '"owner" is not a clusterId — node would reject this token',
    );
  });

  it('falls back to "user" when the string "admin" is passed as clusterId', () => {
    const session = makeSession([{ id: "clus-abc", role: "admin" }]);
    assert.equal(resolveClusterRole(session, "admin"), "user");
  });

  it('falls back to "user" when the string "viewer" is passed as clusterId', () => {
    const session = makeSession([{ id: "clus-abc", role: "viewer" }]);
    assert.equal(resolveClusterRole(session, "viewer"), "user");
  });

  it('falls back to "user" when clusterId is an empty string (pool instance edge case)', () => {
    const session = makeSession([{ id: "clus-abc", role: "developer" }]);
    assert.equal(resolveClusterRole(session, ""), "user");
  });

  it('falls back to "user" when session has no cluster memberships', () => {
    const session = makeSession([]);
    assert.equal(resolveClusterRole(session, "clus-abc"), "user");
  });

  it('falls back to "user" when clusterId does not match any session cluster', () => {
    const session = makeSession([{ id: "clus-abc", role: "owner" }]);
    assert.equal(resolveClusterRole(session, "clus-does-not-exist"), "user");
  });

  it("is case-sensitive — partial or wrong-case clusterId does not match", () => {
    const session = makeSession([{ id: "clus-ABC", role: "owner" }]);
    assert.equal(resolveClusterRole(session, "clus-abc"), "user");
    assert.equal(resolveClusterRole(session, "CLUS-ABC"), "user");
    assert.equal(resolveClusterRole(session, "clus-ABC"), "owner");
  });
});
