import { UserStore } from "./users";
import { ClusterStore } from "./clusters";
import { InstanceStore } from "./instances";

export class D1Store {
    public users: UserStore;
    public clusters: ClusterStore;
    public instances: InstanceStore;

    constructor(db: D1Database) {
        this.users = new UserStore(db);
        this.clusters = new ClusterStore(db);
        this.instances = new InstanceStore(db);
    }
}

export { UserStore, ClusterStore, InstanceStore };
export * from "./base";