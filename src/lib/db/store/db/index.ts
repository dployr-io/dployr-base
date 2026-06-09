// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { UserStore } from "./users.js";
import { ClusterStore } from "./clusters.js";
import { InstanceStore } from "./instances.js";
import { BootstrapTokenStore } from "./bootstrap-tokens.js";
import { DomainStore } from "./domains.js";
import { ServiceStore } from "./services.js";
import { BillingStore } from "./billing.js";
import { DeploymentStore } from "./deployments.js";
import { ServiceEnvStore } from "./service-envs.js";
import { ServiceSecretStore } from "./service-secrets.js";
import { ServiceMetricsStore } from "./service-metrics.js";
import { NotificationsStore } from "./notifications.js";
import { OidcBindingStore } from "./oidc-bindings.js";
import { ApiTokenStore } from "./api-tokens.js";
import { EncryptionService } from "@/lib/crypto/encryption.js";

export class DatabaseStore {
  public users: UserStore;
  public clusters: ClusterStore;
  public instances: InstanceStore;
  public bootstrapTokens: BootstrapTokenStore;
  public domains: DomainStore;
  public services: ServiceStore;
  public deployments: DeploymentStore;
  public billing: BillingStore;
  public serviceEnvs: ServiceEnvStore;
  public serviceSecrets: ServiceSecretStore | null;
  public serviceMetrics: ServiceMetricsStore;
  public notifications: NotificationsStore;
  public oidcBindings: OidcBindingStore;
  public apiTokens: ApiTokenStore;

  constructor(db: PostgresAdapter, encryptionKey: string | undefined = process.env.ENCRYPTION_KEY) {
    this.users = new UserStore(db);
    this.clusters = new ClusterStore(db);
    this.instances = new InstanceStore(db);
    this.bootstrapTokens = new BootstrapTokenStore(db);
    this.domains = new DomainStore(db);
    this.services = new ServiceStore(db);
    this.deployments = new DeploymentStore(db);
    this.billing = new BillingStore(db);
    this.serviceEnvs = new ServiceEnvStore(db);
    this.serviceSecrets = encryptionKey ? new ServiceSecretStore(db, new EncryptionService(encryptionKey)) : null;
    this.serviceMetrics = new ServiceMetricsStore(db);
    this.notifications = new NotificationsStore(db);
    this.oidcBindings = new OidcBindingStore(db);
    this.apiTokens = new ApiTokenStore(db);
  }
}

export const PostgresStore = DatabaseStore;
export { UserStore, ClusterStore, InstanceStore, BootstrapTokenStore, DomainStore, ServiceStore, BillingStore, ServiceMetricsStore, NotificationsStore };
export type { ClusterFilter } from "./clusters.js";
export type { InstanceFilter } from "./instances.js";
export type { ServiceFilter } from "./services.js";
export type { DeploymentFilter } from "./deployments.js";
export type { UserFilter } from "./users.js";
export * from "./base.js";
