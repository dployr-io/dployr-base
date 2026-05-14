// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hobbyIceSupervisor } from "@/services/background/jobs/hobby-ice-supervisor.js";
import { MemoryKV } from "@/lib/storage/kv.interface.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { MS_25_DAYS, MS_30_DAYS } from "@/lib/constants/duration.js";

// Uses a real KVStore backed by MemoryKV so JWTService can generate and sign
// tokens via the KeyStore (auto-generates an RSA key pair on first use).

type FakeService = {
  id: string;
  name: string;
  clusterId: string;
  icedAt: number | null;
  createdAt: number;
};

function makeService(overrides: Partial<FakeService> = {}): FakeService {
  return {
    id: "svc-1",
    name: "my-app",
    clusterId: "cluster-1",
    icedAt: null,
    createdAt: Date.now() - MS_30_DAYS - 1,
    ...overrides,
  };
}

function makeDb(
  services: FakeService[] = [],
  icedServices: string[] = [],
  routingKey: string | null = "instance-tag-1",
  plan: string = "hobby",
) {
  return {
    services: {
      list: async () => ({ services }),
      markIced: async (name: string) => { icedServices.push(name); },
    },
    clusters: {
      find: async ({ id }: { id: string }) => ({ name: `cluster-${id}` }),
    },
    instances: {
      getRoutingKey: async (_clusterId: string) => routingKey,
    },
    billing: {
      getEffectivePlan: async (_clusterId: string) => plan,
    },
  } as any;
}

async function makeRealKv(entries: Record<string, string> = {}) {
  const raw = new MemoryKV();
  for (const [k, v] of Object.entries(entries)) {
    await raw.put(k, v);
  }
  return new KVStore(raw);
}

function makeSentTasks() {
  const sent = { tags: [] as string[], tasks: [] as any[] };
  return sent;
}

function makeAdapters(sentTasks: ReturnType<typeof makeSentTasks>, baseUrl = "https://base.test") {
  return {
    ws: {
      connectionManager: {
        sendTask: (routingKey: string, task: any) => {
          sentTasks.tags.push(routingKey);
          sentTasks.tasks.push(task);
          return true;
        },
      },
    },
    email: null,
    config: { server: { base_url: baseUrl } },
  } as any;
}

const noopCtx = { trigger: () => {}, setOutput: () => {} } as any;

describe("hobbyIceSupervisor", () => {
  it("skips services below 25-day threshold", async () => {
    const svc = makeService({ createdAt: Date.now() - MS_25_DAYS + 1000 });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices);
    const kv = await makeRealKv();
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 0);
    assert.equal(sentTasks.tasks.length, 0);
  });

  it("skips already-iced services", async () => {
    const svc = makeService({ icedAt: Date.now() - 1000 });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices);
    const kv = await makeRealKv();
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 0);
    assert.equal(sentTasks.tasks.length, 0);
  });

  it("skips non-hobby services", async () => {
    const svc = makeService({ createdAt: Date.now() - MS_30_DAYS - 1000 });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices, "instance-tag-1", "pro");
    const kv = await makeRealKv();
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 0);
    assert.equal(sentTasks.tasks.length, 0);
  });

  it("sets warning KV key at day 25–29 without icing", async () => {
    const svc = makeService({ createdAt: Date.now() - MS_25_DAYS - 1000 });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices);
    const kv = await makeRealKv();
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 0, "should not ice at day 25");
    assert.equal(sentTasks.tasks.length, 0);
    const warningVal = await kv.kv.get(KV_KEYS.SERVICE.ICE_WARNING_SENT(svc.name));
    assert.equal(warningVal, "1", "warning KV key should be set");
  });

  it("does not send duplicate warning if warning key already set", async () => {
    const svc = makeService({ createdAt: Date.now() - MS_25_DAYS - 1000 });
    const kv = await makeRealKv({ [KV_KEYS.SERVICE.ICE_WARNING_SENT(svc.name)]: "1" });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices);
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 0);
    assert.equal(sentTasks.tasks.length, 0);
  });

  it("ices service at day 30+ when instance is connected", async () => {
    const svc = makeService({ createdAt: Date.now() - MS_30_DAYS - 1000 });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices, "instance-tag-1");
    const kv = await makeRealKv();
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 1, "service should be marked iced");
    assert.equal(icedServices[0], svc.name);
    assert.equal(sentTasks.tasks.length, 1, "ice task should be dispatched");
    assert.equal(sentTasks.tags[0], "instance-tag-1");
  });

  it("skips ice when no routing key", async () => {
    const svc = makeService({ createdAt: Date.now() - MS_30_DAYS - 1000 });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices, null);
    const kv = await makeRealKv();
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 0);
    assert.equal(sentTasks.tasks.length, 0);
  });

  it("uses KV last_active over createdAt when present", async () => {
    const svc = makeService({ createdAt: Date.now() - MS_30_DAYS - 1000 });
    const kv = await makeRealKv({
      [KV_KEYS.SERVICE.LAST_ACTIVE(svc.name)]: String(Date.now() - 1000),
    });
    const icedServices: string[] = [];
    const db = makeDb([svc], icedServices, "instance-tag-1");
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(icedServices.length, 0, "recently-active service should not be iced");
    assert.equal(sentTasks.tasks.length, 0);
  });

  it("does nothing when service list is empty", async () => {
    const db = makeDb([], []);
    const kv = await makeRealKv();
    const sentTasks = makeSentTasks();

    await hobbyIceSupervisor({ db, kv, adapters: makeAdapters(sentTasks), ...noopCtx });

    assert.equal(sentTasks.tasks.length, 0);
  });
});
