// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseStore } from "@/lib/db/store/db/base.js";
import { DatabaseConflictError } from "@/lib/errors/errors.js";
import type { AllowedTable } from "@/lib/constants/index.js";

// Minimal concrete subclass that exposes protected methods for testing.
class TestStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "users";

  constructor() {
    super(null as any); // db not needed for pure method tests
  }

  callParsePostgresError(error: unknown): never {
    return this.parsePostgresError(error);
  }

  callBuildWhere(cols: Record<string, any>) {
    return this.buildWhere(cols);
  }

  callMergeJson(args: { existing: any; updates: any }) {
    return this.mergeJson(args);
  }
}

const store = new TestStore();

describe("BaseStore.parsePostgresError", () => {
  it("throws DatabaseConflictError with extracted field for 23505", () => {
    const err = Object.assign(new Error("duplicate"), {
      code: "23505",
      detail: 'Key (email)=(test@test.com) already exists.',
    });
    assert.throws(
      () => store.callParsePostgresError(err),
      (e: unknown) => e instanceof DatabaseConflictError && e.field === "email" && e.table === "users",
    );
  });

  it("uses 'unknown' field when detail is missing", () => {
    const err = Object.assign(new Error("duplicate"), { code: "23505" });
    assert.throws(
      () => store.callParsePostgresError(err),
      (e: unknown) => e instanceof DatabaseConflictError && e.field === "unknown",
    );
  });

  it("throws DatabaseConflictError with foreign_key field for 23503", () => {
    const err = Object.assign(new Error("fk violation"), { code: "23503" });
    assert.throws(
      () => store.callParsePostgresError(err),
      (e: unknown) => e instanceof DatabaseConflictError && e.field === "foreign_key",
    );
  });

  it("re-throws unrecognised errors as-is", () => {
    const err = new Error("something else");
    assert.throws(() => store.callParsePostgresError(err), err);
  });

  it("re-throws non-Error values as-is", () => {
    assert.throws(() => store.callParsePostgresError("raw string"), (e: unknown) => e === "raw string");
  });
});

describe("BaseStore.buildWhere", () => {
  it("returns empty clause and bindings for empty object", () => {
    const { clause, bindings } = store.callBuildWhere({});
    assert.equal(clause, "");
    assert.deepEqual(bindings, []);
  });

  it("builds a single-field WHERE clause", () => {
    const { clause, bindings } = store.callBuildWhere({ id: "abc" });
    assert.equal(clause, "WHERE id = $1");
    assert.deepEqual(bindings, ["abc"]);
  });

  it("builds a multi-field WHERE clause", () => {
    const { clause, bindings } = store.callBuildWhere({ id: "abc", status: "active" });
    assert.equal(clause, "WHERE id = $1 AND status = $2");
    assert.deepEqual(bindings, ["abc", "active"]);
  });

  it("filters out undefined values", () => {
    const { clause, bindings } = store.callBuildWhere({ id: "abc", status: undefined });
    assert.equal(clause, "WHERE id = $1");
    assert.deepEqual(bindings, ["abc"]);
  });

  it("accepts null as a valid binding value", () => {
    const { clause, bindings } = store.callBuildWhere({ deleted_at: null });
    assert.equal(clause, "WHERE deleted_at = $1");
    assert.deepEqual(bindings, [null]);
  });
});

describe("BaseStore.mergeJson", () => {
  it("merges updates over existing fields", () => {
    const result = store.callMergeJson({ existing: { a: 1, b: 2 }, updates: { b: 99, c: 3 } });
    assert.deepEqual(result, { a: 1, b: 99, c: 3 });
  });

  it("handles null existing gracefully", () => {
    const result = store.callMergeJson({ existing: null, updates: { x: 1 } });
    assert.deepEqual(result, { x: 1 });
  });

  it("handles null updates gracefully", () => {
    const result = store.callMergeJson({ existing: { a: 1 }, updates: null });
    assert.deepEqual(result, { a: 1 });
  });

  it("returns empty object when both are null", () => {
    const result = store.callMergeJson({ existing: null, updates: null });
    assert.deepEqual(result, {});
  });
});
