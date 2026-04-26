// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { UserStore } from "./users.js";
import { ClusterStore } from "./clusters.js";
import { InstanceStore } from "./instances.js";
import { InstancePoolStore } from "./instance-pool.js";
import { BootstrapTokenStore } from "./bootstrap-tokens.js";
import { DomainStore } from "./domains.js";
import { ServiceStore } from "./services.js";
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

  constructor(db: PostgresAdapter) {
    this.users = new UserStore(db);
    this.clusters = new ClusterStore(db);
    this.instances = new InstanceStore(db);
    this.instancePool = new InstancePoolStore(db);
    this.bootstrapTokens = new BootstrapTokenStore(db);
    this.domains = new DomainStore(db);
    this.services = new ServiceStore(db);
    this.subscriptions = new SubscriptionStore(db);
  }
}

export const PostgresStore = DatabaseStore;
export { UserStore, ClusterStore, InstanceStore, InstancePoolStore, BootstrapTokenStore, DomainStore, ServiceStore, SubscriptionStore };
export type { InstanceFilter, InstanceUpdateData } from "./instances.js";
export type { ServiceFilter } from "./services.js";
export type { UserFilter } from "./users.js";
export * from "./base.js";
