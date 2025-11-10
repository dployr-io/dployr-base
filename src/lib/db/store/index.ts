import { UserStore } from "./users";
import { ClusterStore } from "./clusters";
import { InstanceStore } from "./instances";
import { BootstrapStore } from "./bootstrap";

export class D1Store {
    public users: UserStore;
    public clusters: ClusterStore;
    public instances: InstanceStore;
    public bootstraps: BootstrapStore;

    constructor(db: D1Database) {
        this.users = new UserStore(db);
        this.clusters = new ClusterStore(db);
        this.instances = new InstanceStore(db);
        this.bootstraps = new BootstrapStore(db);
    }
}

export { UserStore, ClusterStore, InstanceStore };
export * from "./base";