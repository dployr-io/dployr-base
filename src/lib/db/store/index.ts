import { UserStore } from "./users";
import { ClusterStore } from "./clusters";
import { InstanceStore } from "./instances";
import { BootstrapTokenStore } from "./bootstrap_tokens";

export class D1Store {
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

export { UserStore, ClusterStore, InstanceStore, BootstrapTokenStore };
export * from "./base";