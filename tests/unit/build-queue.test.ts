// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "@/lib/storage/kv.interface.js";
import { PayloadStore } from "@/lib/db/store/kv/payload.js";
import type { BuildQueueEntry } from "@/lib/db/store/kv/payload.js";

function makeStore() {
  return new PayloadStore(new MemoryKV());
}

function entry(overrides: Partial<BuildQueueEntry> = {}): BuildQueueEntry {
  return {
    taskId: "task-" + Math.random().toString(36).slice(2),
    clusterId: "cluster-1",
    callbackInstanceTag: "instance-1",
    payload: { name: "app", user_id: "u1", type: "web", source: "remote", runtime: "nodejs", force_rebuild: false } as any,
    fingerprint: "fp-abc",
    tier: "hobby",
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

describe("PayloadStore — build queue", () => {
  it("enqueued entry is returned by listBuildQueue", async () => {
    const store = makeStore();
    const e = entry({ taskId: "t1" });
    await store.enqueueBuild(e);

    const queue = await store.listBuildQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].taskId, "t1");
    assert.equal(queue[0].fingerprint, "fp-abc");
  });

  it("pro cluster dispatches before hobby regardless of enqueue order", async () => {
    const store = makeStore();
    const hobbyEntry = entry({ taskId: "hobby-1", tier: "hobby", enqueuedAt: 1000 });
    const proEntry = entry({ taskId: "pro-1", tier: "pro", enqueuedAt: 2000 }); // enqueued later

    await store.enqueueBuild(hobbyEntry);
    await store.enqueueBuild(proEntry);

    const queue = await store.listBuildQueue();
    assert.equal(queue[0].taskId, "pro-1", "pro preempts hobby even when enqueued later");
    assert.equal(queue[1].taskId, "hobby-1");
  });

  it("indie dispatches before hobby, after pro", async () => {
    const store = makeStore();
    await store.enqueueBuild(entry({ taskId: "hobby", tier: "hobby", enqueuedAt: 100 }));
    await store.enqueueBuild(entry({ taskId: "indie", tier: "indie", enqueuedAt: 200 }));
    await store.enqueueBuild(entry({ taskId: "pro", tier: "pro", enqueuedAt: 300 }));

    const queue = await store.listBuildQueue();
    assert.deepEqual(queue.map((e) => e.taskId), ["pro", "indie", "hobby"]);
  });

  it("FIFO within same tier — earlier enqueuedAt dispatches first", async () => {
    const store = makeStore();
    await store.enqueueBuild(entry({ taskId: "first", tier: "indie", enqueuedAt: 1000 }));
    await store.enqueueBuild(entry({ taskId: "second", tier: "indie", enqueuedAt: 2000 }));
    await store.enqueueBuild(entry({ taskId: "third", tier: "indie", enqueuedAt: 3000 }));

    const queue = await store.listBuildQueue();
    assert.deepEqual(queue.map((e) => e.taskId), ["first", "second", "third"]);
  });

  it("dequeue removes the entry from the list", async () => {
    const store = makeStore();
    await store.enqueueBuild(entry({ taskId: "remove-me" }));
    await store.enqueueBuild(entry({ taskId: "keep-me" }));

    await store.dequeueBuild("remove-me");

    const queue = await store.listBuildQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].taskId, "keep-me");
  });

  it("dequeue of last entry empties the queue entirely", async () => {
    const store = makeStore();
    await store.enqueueBuild(entry({ taskId: "only" }));
    await store.dequeueBuild("only");

    const queue = await store.listBuildQueue();
    assert.equal(queue.length, 0);
  });

  it("dequeueBuild is idempotent — second call does not throw", async () => {
    const store = makeStore();
    await store.enqueueBuild(entry({ taskId: "once" }));
    await store.dequeueBuild("once");
    await assert.doesNotReject(() => store.dequeueBuild("once"));
  });

  it("enqueueBuild is idempotent — duplicate taskId not added twice", async () => {
    const store = makeStore();
    const e = entry({ taskId: "dup" });
    await store.enqueueBuild(e);
    await store.enqueueBuild(e);

    const queue = await store.listBuildQueue();
    assert.equal(queue.length, 1);
  });
});

describe("PayloadStore — build callback", () => {
  it("consumeBuildCallback returns the stored callback then null on second call", async () => {
    const store = makeStore();
    await store.saveBuildCallback("task-1", {
      callbackInstanceTag: "inst-a",
      buildNodeTag: "build-1",
      clusterId: "cluster-1",
      payload: { name: "svc" } as any,
      fingerprint: "fp-xyz",
    });

    const first = await store.consumeBuildCallback("task-1");
    assert.ok(first, "first consume should return the callback");
    assert.equal(first!.callbackInstanceTag, "inst-a");
    assert.equal(first!.fingerprint, "fp-xyz");

    const second = await store.consumeBuildCallback("task-1");
    assert.equal(second, null, "second consume must return null — callback was already consumed");
  });

  it("callback for unknown taskId returns null", async () => {
    const store = makeStore();
    const result = await store.consumeBuildCallback("does-not-exist");
    assert.equal(result, null);
  });
});
