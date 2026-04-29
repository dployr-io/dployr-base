// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Bindings } from "./bindings.js";
import { IStorageAdapter } from "@/lib/config/context.js";
import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { AuthService } from "@/services/auth/index.js";
import { JWTService } from "@/services/auth/jwt.js";
import { OAuthService } from "@/services/auth/oauth.js";
import { BillingService } from "@/services/billing/index.js";
import { BillingProvider } from "@/services/billing/provider.js";
import { DnsService } from "@/services/dns/index.js";
import { InstanceService } from "@/services/instances.js";
import { BitBucketService } from "@/services/integrations/bitbucket.js";
import { GitHubService } from "@/services/integrations/github.js";
import { GitLabService } from "@/services/integrations/gitlab.js";
import { IntegrationsService } from "@/services/integrations/index.js";
import { NotificationService } from "@/services/notifications/index.js";
import { TrafficRouter } from "@/services/proxy/traffic-router.js";
import { WebSocketHandler } from "@/services/websocket/instance-handler.js";
import type { NotificationEvent } from "@/services/notifications/notifier.js";
import { VmProvider } from "@/services/vm/index.js";
import { InstancePool } from "@/services/pool.js";
import { EmailProvider } from "@/services/notifications/email/index.js";
import { INSTANCE_REGIONS } from "@/lib/constants/instances.js";

export type { Bindings };

export type RequiredOnly<T, K extends keyof T> = Required<Pick<T, K>> & Partial<Omit<T, K>>;

export type OAuthProvider = "google" | "github" | "microsoft" | "email";

export type Role = "owner" | "admin" | "developer" | "viewer" | "invited";

export type BootstrapType = "github";

export const integrationIds = ["resendMail", "mailChimp", "mailerSend", "discord", "slack", "gitHub", "gitLab", "bitBucket", "godaddy", "cloudflare", "route53"] as const;

export type IntegrationType = (typeof integrationIds)[number];

export interface Service {
  id: string;
  instanceId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface User {
  id: string;
  email: string;
  picture?: string | undefined;
  name?: string | undefined;
  provider: OAuthProvider;
  metadata?: Record<string, any> | undefined;
  createdAt: number;
  updatedAt: number;
}

export type SubscriptionPlan = "hobby" | "indie" | "pro";
export type SubscriptionStatus = "active" | "canceled" | "past_due";

export interface ClusterSubscription {
  clusterId: string;
  plan: SubscriptionPlan;
  polarCustomerId: string | null;
  polarSubscriptionId: string | null;
  status: SubscriptionStatus;
  canceledAt: number | null;
  periodEnd: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  userId: string;
  email: string;
  provider: OAuthProvider;
  clusters: { id: string; name: string; owner: string; role: string }[];
  createdAt: number;
  expiresAt: number;
}

export type Variables = {
  kvAdapter?: IKVAdapter;
  dbAdapter?: PostgresAdapter;
  storageAdapter?: IStorageAdapter;
  wsHandler?: WebSocketHandler;
  _dbStore?: DatabaseStore;
  _kvStore?: KVStore;
  _authService?: AuthService;
  _jwtService?: JWTService;
  _notificationService?: NotificationService;
  _oauthService?: OAuthService;
  _githubService?: GitHubService;
  _gitLabService?: GitLabService;
  _bitBucketService?: BitBucketService;
  _integrationsService?: IntegrationsService;
  _instanceService?: InstanceService;
  _instancePoolService?: InstancePool;
  _dnsService?: DnsService;
  _billingService?: BillingService;
  _trafficRouter?: TrafficRouter;
  billingProvider?: BillingProvider | null;
  vmProvider?: VmProvider | null;
  emailProvider?: EmailProvider | null;
  session?: Session;
  resolvedClusterId?: string;
};

export type ActorType = "user" | "headless";

export type SystemStatus = {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: string;
  services: {
    total: number;
    running: number;
    stopped: number;
  };
  proxy: {
    status: "running" | "stopped";
    routes: number;
  };
};

export type StatusUpdateMessage = {
  kind: "status_update";
  timestamp: number;
  system: SystemStatus;
};

/**
 * @property "healthy" - Fully available
 * @property "degraded" - Reachable but dployrd not responding
 * @property "offline" - Turned off but still provisioned on the VM provider
 * @property "unreachable" - Not reachable by TCP ping 
 * @property "maintenance" - Taken out of pool rotation
 */
export type InstanceStatus = "healthy" | "degraded" | "offline" | "unreachable" | "maintenance";

export type InstanceRegion = (typeof INSTANCE_REGIONS)[number];

/** dedicated = user-managed, belongs to one cluster; pool = platform-managed, shared across many clusters */
export type InstanceKind = "dedicated" | "pool";

export interface Instance {
  id: string;
  kind: InstanceKind;
  /** null only for pool instances before their VM is provisioned */
  address: string | null;
  tag: string;
  status: InstanceStatus;
  /** present only for pool instances */
  capacity?: number;
  /** present only for pool instances */
  region?: string;
  /** null for pool instances (no single owning cluster) */
  clusterId?: string | null;
  /** whether the instance is a managed instance or BYO server setup */
  managed?: boolean;
  metadata?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface Cluster {
  id: string;
  name: string;
  users: string[]; // Array of user emails
  roles: Record<Role, string[]>; // role -> array of user emails
  poolInstanceId?: string | null;
  metadata?: Record<string, any> | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface GitHubIntegration {
  loginId: string;
  installUrl: string;
  installationId: number;
  remotesCount: number;
}

export interface GitLabIntegration {
  loginId: string;
  accessToken: string;
  remotesCount: number;
  enabled: boolean;
}

export interface BitBucketIntegration {
  loginId: string;
  accessToken: string;
  remotesCount: number;
  enabled: boolean;
}

export interface Remote {
  url: string;
  branch: string;
  commit_hash?: string | null;
  avatar_url?: string | null;
}

export interface RemoteListResult {
  provider: "github" | "gitlab" | "bitbucket";
  remotes: Remote[];
  error?: string;
}

export interface ResendMailIntegration {}

export interface ZohoMailIntegration {}

export interface MailerSendIntegration {}

export interface MailChimpIntegration {}

export interface DiscordIntegration {
  webhookUrl: string;
  enabled: boolean;
  events?: NotificationEvent[];
}

export interface SlackIntegration {
  webhookUrl: string;
  enabled: boolean;
  events?: NotificationEvent[];
}

export interface CustomWebhookIntegration {
  webhookUrl: string;
  enabled: boolean;
  events?: NotificationEvent[];
}

export interface EmailNotificationIntegration {
  enabled: boolean;
  events?: NotificationEvent[];
}

export interface Integrations {
  email: {
    resendMail: ResendMailIntegration;
    zohoMail: ZohoMailIntegration;
    mailerSend: MailerSendIntegration;
    mailChimp: MailChimpIntegration;
  };
  remote: {
    gitHub: GitHubIntegration;
    gitLab: GitLabIntegration;
    bitBucket: BitBucketIntegration;
  };
  notification: {
    discord: DiscordIntegration;
    slack: SlackIntegration;
    customWebhook: CustomWebhookIntegration;
    email: EmailNotificationIntegration;
  };
}

export interface ProxyServerConfig {
  port: number; // Port to listen on
  host: string; // Host to bind to
  baseDomain: string; // Base domain for routing
  timeoutMs: number; // Request timeout in milliseconds
}

/** Payload passed to notification triggers. `clusterId` is required to look up integrations. */
export interface NotificationData {
  /** Cluster whose integrations (Discord, Slack, webhooks, email) will be notified. */
  clusterId: string;
  /** Instance related to the event, if applicable. */
  instanceId?: string;
  /** Email of the user who triggered the event, used in notification templates. */
  userEmail?: string;
  [key: string]: any;
}

export interface ConnectionManagerConfig {
  requestTimeoutMs: number;
  cleanupIntervalMs: number;
  maxPendingPerClient: number;
  connectionTtlMs: number;
}

// Export response types
export * from "./responses.js";

// Export node types
export * from "./node.js";
