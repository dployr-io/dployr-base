// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { UserStore } from "./users.js";
import { ClusterStore } from "./clusters.js";
import { InstanceStore } from "./instances.js";
import { BootstrapTokenStore } from "./bootstrap_tokens.js";
import { DomainStore } from "./domains.js";
import { ServiceStore } from "./services.js";
import { KVStore } from "./kv.js";

export class DatabaseStore {
    public users: UserStore;
    public clusters: ClusterStore;
    public instances: InstanceStore;
    public bootstrapTokens: BootstrapTokenStore;
    public domains: DomainStore;
    public services: ServiceStore;

    constructor(db: PostgresAdapter, kv?: KVStore) {
        this.users = new UserStore(db);
        this.clusters = new ClusterStore(db);
        this.instances = new InstanceStore(db, kv);
        this.bootstrapTokens = new BootstrapTokenStore(db);
        this.domains = new DomainStore(db);
        this.services = new ServiceStore(db, kv);
    }
}

export const PostgresStore = DatabaseStore;
export { UserStore, ClusterStore, InstanceStore, BootstrapTokenStore, DomainStore, ServiceStore };
export * from "./base.js";