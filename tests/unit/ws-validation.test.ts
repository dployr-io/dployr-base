// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMessage, getSchemaForKind, FileReadMessageSchema, InstanceCreateMessageSchema } from "@/services/websocket/validation.js";

describe("validateMessage", () => {
  it("returns success for a valid file_read message", () => {
    const msg = { kind: "file_read", requestId: "req-1", instanceId: "inst-1", path: "/etc/hosts" };
    const result = validateMessage(FileReadMessageSchema, msg);
    assert.equal(result.success, true);
  });

  it("returns failure with error string for missing required fields", () => {
    const msg = { kind: "file_read" }; // missing requestId, instanceId, path
    const result = validateMessage(FileReadMessageSchema, msg);
    assert.equal(result.success, false);
    assert.ok(result.success === false && result.error.length > 0);
  });

  it("returns failure for wrong type on a field", () => {
    const msg = { kind: "file_read", requestId: 123, instanceId: "inst-1", path: "/tmp" };
    const result = validateMessage(FileReadMessageSchema, msg);
    assert.equal(result.success, false);
  });
});

describe("getSchemaForKind", () => {
  const knownKinds = [
    "file_read", "file_write", "file_create", "file_delete", "file_tree",
    "task_response", "instance_list", "instance_create", "instance_delete",
    "instance_token_rotate", "instance_system_install",
    "instance_system_reboot", "instance_system_restart",
  ];

  for (const kind of knownKinds) {
    it(`returns a schema for "${kind}"`, () => {
      assert.ok(getSchemaForKind(kind) !== null);
    });
  }

  it("returns null for an unknown kind", () => {
    assert.equal(getSchemaForKind("unknown_kind"), null);
  });
});

describe("InstanceCreateMessageSchema — IP validation", () => {
  it("accepts a valid IPv4 address", () => {
    const msg = { kind: "instance_create", requestId: "r1", clusterId: "c1", address: "192.168.1.100", tag: "my-node" };
    const result = validateMessage(InstanceCreateMessageSchema, msg);
    assert.equal(result.success, true);
  });

  it("rejects a hostname instead of IPv4", () => {
    const msg = { kind: "instance_create", requestId: "r1", clusterId: "c1", address: "my-server.local", tag: "my-node" };
    const result = validateMessage(InstanceCreateMessageSchema, msg);
    assert.equal(result.success, false);
  });

  it("rejects an out-of-range octet", () => {
    const msg = { kind: "instance_create", requestId: "r1", clusterId: "c1", address: "256.0.0.1", tag: "my-node" };
    const result = validateMessage(InstanceCreateMessageSchema, msg);
    assert.equal(result.success, false);
  });

  it("rejects a tag shorter than 3 chars", () => {
    const msg = { kind: "instance_create", requestId: "r1", clusterId: "c1", address: "10.0.0.1", tag: "ab" };
    const result = validateMessage(InstanceCreateMessageSchema, msg);
    assert.equal(result.success, false);
  });
});
