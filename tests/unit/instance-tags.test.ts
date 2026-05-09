// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInstanceTags, INSTANCE_ENV_TAG } from "@/lib/constants/vm.js";

describe("buildInstanceTags", () => {
  it("always includes 'managed'", () => {
    for (const tier of ["hobby", "indie", "pro"] as const) {
      assert.ok(buildInstanceTags(tier).includes("managed"));
    }
  });

  it("includes the tier as a tag", () => {
    assert.ok(buildInstanceTags("hobby").includes("hobby"));
    assert.ok(buildInstanceTags("indie").includes("indie"));
    assert.ok(buildInstanceTags("pro").includes("pro"));
  });

  it("includes the current env tag", () => {
    const tags = buildInstanceTags("hobby");
    assert.ok(tags.includes(INSTANCE_ENV_TAG), `Expected '${INSTANCE_ENV_TAG}' in ${JSON.stringify(tags)}`);
  });

  it("does not mix env tags across environments", () => {
    const tags = buildInstanceTags("hobby");
    const hasProd = tags.includes("production") || tags.includes("prod");
    const hasDev = tags.includes("development") || tags.includes("dev");
    assert.ok(hasProd !== hasDev, "Tags should include either prod or dev env tags, not both");
  });
});
