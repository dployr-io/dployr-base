// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { UserStore } from "./users.js";
import { ClusterStore } from "./clusters.js";
import { InstanceStore } from "./instances.js";
import { InstancePoolStore } from "./instance-pool.js";
import { BootstrapTokenStore } from "./bootstrap_tokens.js";
import { DomainStore } from "./domains.js";
import { ServiceStore } from "./services.js";
import { KVStore } from "../kv/index.js";
import { SubscriptionStore } from "./subscriptions.js";

export class DatabaseStore {
  public users: UserStore;
  public clusters: ClusterStore;
  public instances: InstanceStore;
  public instancePool: InstancePoolStore;
  public bootstrapTokens: BootstrapTokenStore;
  public domains: DomainStore;
  public services: ServiceStore;
  public subscriptions: SubscriptionStore;

  constructor(db: PostgresAdapter, kv?: KVStore) {
    this.users = new UserStore(db);
    this.clusters = new ClusterStore(db);
    this.instances = new InstanceStore(db, kv);
    this.instancePool = new InstancePoolStore(db);
    this.bootstrapTokens = new BootstrapTokenStore(db);
    this.domains = new DomainStore(db);
    this.services = new ServiceStore(db, kv);
    this.subscriptions = new SubscriptionStore(db);
  }
}

export const PostgresStore = DatabaseStore;
export { UserStore, ClusterStore, InstanceStore, InstancePoolStore, BootstrapTokenStore, DomainStore, ServiceStore, SubscriptionStore };
export * from "./base.js";
