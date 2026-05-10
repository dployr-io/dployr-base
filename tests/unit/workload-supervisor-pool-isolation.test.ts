// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { KV_KEYS } from "@/lib/constants/kv.js";


type FakeInstance = { id: string; tag: string; kind: "pool" | "dedicated"; clusterId?: string; address?: string };
type FakeDeployment = { id: string; clusterId: string; name: string; userId: string };
type FakeService = { id: string; name: string; type: string; clusterId: string; deploymentId?: string };
type FakeCluster = { id: string; name: string; poolInstanceId?: string };

function makeDb({
  instances = [] as FakeInstance[],
  deployments = [] as FakeDeployment[],
  clusters = [] as FakeCluster[],
  services = [] as FakeService[],
  upsertedServices = [] as any[],
}) {
  return {
    instances: {
      find: async (filter: any) => {
        if (filter.id) return instances.find((i) => i.id === filter.id) ?? null;
        if (filter.tag) return instances.find((i) => i.tag === filter.tag) ?? null;
        if (filter.clusterId && filter.kind) return instances.find((i) => i.clusterId === filter.clusterId && i.kind === filter.kind) ?? null;
        return null;
      },
    },
    deployments: {
      get: async (id: string) => deployments.find((d) => d.id === id) ?? null,
      list: async (filter: any) => ({
        deployments: filter.clusterId
          ? deployments.filter((d) => d.clusterId === filter.clusterId)
          : deployments,
      }),
    },
    clusters: {
      list: async () => ({ clusters }),
    },
    services: {
      list: async (filter: any) => ({ services: services.filter((s) => s.clusterId === filter.clusterId) }),
      upsert: async (data: any) => {
        upsertedServices.push(data);
      },
    },
    serviceSecrets: null,
  } as any;
}

function makeKv(workloadsByNodeTag: Record<string, Array<Record<string, unknown>>>) {
  return {
    entities: {
      getEntity: async (key: string) => {
        for (const [tag, services] of Object.entries(workloadsByNodeTag)) {
          if (key === KV_KEYS.INSTANCE.ENTITY(tag, "workloads")) {
            return { data: { services }, version: 1 };
          }
        }
        return null;
      },
    },
    instanceCache: {
      registerClusterNode: async () => {},
      deregisterClusterNode: async () => {},
    },
  } as any;
}

function makeConnectionManager(connectedTags: string[]) {
  return {
    hasNodeConnection: (tag: string) => connectedTags.includes(tag),
    sendTask: () => false,
  } as any;
}

const noopJwt = { createReprovisionToken: async () => "tok" } as any;
const noopDployrd = { createDeployTask: () => ({}) } as any;
const noopNotifier = {
  notifyRefresh: () => {},
  broadcast: async () => {},
} as any;


describe("WorkloadSupervisor — pool node isolation", () => {
  it("only creates services whose deployment belongs to the supervised cluster", async () => {
    const poolTag = "pool-1";

    const clusterA: FakeCluster = { id: "cluster-a", name: "Cluster A", poolInstanceId: "inst-pool-1" };
    const clusterB: FakeCluster = { id: "cluster-b", name: "Cluster B", poolInstanceId: "inst-pool-1" };

    const poolInstance: FakeInstance = { id: "inst-pool-1", tag: poolTag, kind: "pool" };

    const deploymentA: FakeDeployment = { id: "dep-a", clusterId: "cluster-a", name: "app-a", userId: "u1" };
    const deploymentB: FakeDeployment = { id: "dep-b", clusterId: "cluster-b", name: "app-b", userId: "u2" };

    // Pool node reports both clusters' services in the same workloads entity
    const poolWorkloads = [
      { name: "app-a", type: "web", deployment_id: "dep-a" },
      { name: "app-b", type: "web", deployment_id: "dep-b" },
    ];

    const upsertedServices: any[] = [];

    const db = makeDb({
      instances: [poolInstance],
      deployments: [deploymentA, deploymentB],
      clusters: [clusterA],      // only supervising cluster A
      services: [],
      upsertedServices,
    });

    const kv = makeKv({ [poolTag]: poolWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const supervisor = new WorkloadSupervisor(db, kv, connManager, noopJwt, noopDployrd, noopNotifier);
    await supervisor.run();

    const createdNames = upsertedServices.map((s) => s.name);
    assert.ok(createdNames.includes("app-a"), "should create cluster A's own service");
    assert.ok(!createdNames.includes("app-b"), "should NOT create cluster B's service under cluster A");
  });

  it("skips pool node services that have no deployment_id", async () => {
    const poolTag = "pool-1";

    const clusterA: FakeCluster = { id: "cluster-a", name: "Cluster A", poolInstanceId: "inst-pool-1" };
    const poolInstance: FakeInstance = { id: "inst-pool-1", tag: poolTag, kind: "pool" };

    // Service with no deployment_id — cannot be attributed to any cluster
    const poolWorkloads = [{ name: "mystery-svc", type: "web" }];

    const upsertedServices: any[] = [];

    const db = makeDb({
      instances: [poolInstance],
      deployments: [],
      clusters: [clusterA],
      services: [],
      upsertedServices,
    });

    const kv = makeKv({ [poolTag]: poolWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const supervisor = new WorkloadSupervisor(db, kv, connManager, noopJwt, noopDployrd, noopNotifier);
    await supervisor.run();

    assert.equal(upsertedServices.length, 0, "should not create services without a deployment link on a pool node");
  });

  it("does not filter services on a dedicated node (no deployment_id required)", async () => {
    const dedicatedTag = "dedicated-1";

    const clusterA: FakeCluster = { id: "cluster-a", name: "Cluster A" }; // no poolInstanceId
    const dedicatedInstance: FakeInstance = { id: "inst-ded-1", tag: dedicatedTag, kind: "dedicated", clusterId: "cluster-a" };

    // Service with no deployment_id on a dedicated node — should still be picked up
    const nodeWorkloads = [{ name: "standalone-svc", type: "web" }];

    const upsertedServices: any[] = [];

    const db = makeDb({
      instances: [dedicatedInstance],
      deployments: [],
      clusters: [clusterA],
      services: [],
      upsertedServices,
    });

    const kv = makeKv({ [dedicatedTag]: nodeWorkloads });
    const connManager = makeConnectionManager([dedicatedTag]);

    const supervisor = new WorkloadSupervisor(db, kv, connManager, noopJwt, noopDployrd, noopNotifier);
    await supervisor.run();

    const createdNames = upsertedServices.map((s) => s.name);
    assert.ok(createdNames.includes("standalone-svc"), "dedicated node services without deployment_id should still be created");
  });

  it("matches services by name, not by ID (handles reprovisioning with new deployment ID)", async () => {
    const poolTag = "pool-1";

    const clusterA: FakeCluster = { id: "cluster-a", name: "Cluster A", poolInstanceId: "inst-pool-1" };
    const poolInstance: FakeInstance = { id: "inst-pool-1", tag: poolTag, kind: "pool" };

    // Simulate reprovisioning: old deployment with old ID, new deployment with new ID, same name
    const oldDeployment: FakeDeployment = { id: "dep-old-id", clusterId: "cluster-a", name: "app", userId: "u1" };
    const newDeployment: FakeDeployment = { id: "dep-new-id", clusterId: "cluster-a", name: "app", userId: "u1" };

    // Node reports service with OLD deployment ID (stale)
    const poolWorkloads = [{ name: "app", type: "web", deployment_id: "dep-old-id" }];

    const upsertedServices: any[] = [];

    const db = makeDb({
      instances: [poolInstance],
      deployments: [newDeployment],  // Only the new deployment exists in DB
      clusters: [clusterA],
      services: [],
      upsertedServices,
    });

    const kv = makeKv({ [poolTag]: poolWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const supervisor = new WorkloadSupervisor(db, kv, connManager, noopJwt, noopDployrd, noopNotifier);
    await supervisor.run();

    const createdNames = upsertedServices.map((s) => s.name);
    assert.ok(
      createdNames.includes("app"),
      "should match service by NAME even though deployment ID is stale (reprovisioned)"
    );
  });

  it("excludes pool node services that have no matching deployment by name", async () => {
    const poolTag = "pool-1";

    const clusterA: FakeCluster = { id: "cluster-a", name: "Cluster A", poolInstanceId: "inst-pool-1" };
    const poolInstance: FakeInstance = { id: "inst-pool-1", tag: poolTag, kind: "pool" };

    const deploymentA: FakeDeployment = { id: "dep-a", clusterId: "cluster-a", name: "app-a", userId: "u1" };

    // Node reports two services, only one has a matching deployment
    const poolWorkloads = [
      { name: "app-a", type: "web" },
      { name: "orphaned-app", type: "web" },
    ];

    const upsertedServices: any[] = [];

    const db = makeDb({
      instances: [poolInstance],
      deployments: [deploymentA],  // Only app-a has a deployment
      clusters: [clusterA],
      services: [],
      upsertedServices,
    });

    const kv = makeKv({ [poolTag]: poolWorkloads });
    const connManager = makeConnectionManager([poolTag]);

    const supervisor = new WorkloadSupervisor(db, kv, connManager, noopJwt, noopDployrd, noopNotifier);
    await supervisor.run();

    const createdNames = upsertedServices.map((s) => s.name);
    assert.ok(createdNames.includes("app-a"), "should create service with matching deployment");
    assert.ok(!createdNames.includes("orphaned-app"), "should skip service without matching deployment by name");
  });
});
