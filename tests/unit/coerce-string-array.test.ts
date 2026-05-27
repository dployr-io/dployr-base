import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceStringArray } from "@/lib/constants/config.js";

describe("coerceStringArray", () => {
  it("passes through an existing array unchanged", () => {
    assert.deepEqual(coerceStringArray(["1.2.3.4", "5.6.7.8"]), ["1.2.3.4", "5.6.7.8"]);
  });

  it("converts a single IP string to array", () => {
    assert.deepEqual(coerceStringArray("1.2.3.4"), ["1.2.3.4"]);
  });

  it("splits a comma-separated string", () => {
    assert.deepEqual(coerceStringArray("1.2.3.4, 5.6.7.8"), ["1.2.3.4", "5.6.7.8"]);
  });

  it("parses a JSON-encoded array string", () => {
    assert.deepEqual(coerceStringArray('["1.2.3.4", "5.6.7.8"]'), ["1.2.3.4", "5.6.7.8"]);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(coerceStringArray(""), []);
  });

  it("returns empty array for undefined", () => {
    assert.deepEqual(coerceStringArray(undefined), []);
  });

  it("returns empty array for null", () => {
    assert.deepEqual(coerceStringArray(null), []);
  });

  it("trims whitespace around entries", () => {
    assert.deepEqual(coerceStringArray("  1.2.3.4  ,  5.6.7.8  "), ["1.2.3.4", "5.6.7.8"]);
  });

  it("falls back to comma-split when JSON parse fails", () => {
    assert.deepEqual(coerceStringArray("[invalid"), ["[invalid"]);
  });
});
