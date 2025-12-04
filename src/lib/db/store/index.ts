// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { UserStore } from "./users.js";
import { ClusterStore } from "./clusters.js";
import { InstanceStore } from "./instances.js";
import { BootstrapTokenStore } from "./bootstrap_tokens.js";

export class DatabaseStore {
    public users: UserStore;
    public clusters: ClusterStore;
    public instances: InstanceStore;
    public bootstrapTokens: BootstrapTokenStore;

    constructor(db: D1Database) {
        this.users = new UserStore(db);
        this.clusters = new ClusterStore(db);
        this.instances = new InstanceStore(db);
        this.bootstrapTokens = new BootstrapTokenStore(db);
    }
}

export const D1Store = DatabaseStore;
export { UserStore, ClusterStore, InstanceStore, BootstrapTokenStore };
export * from "./base.js";