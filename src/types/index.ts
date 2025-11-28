/**
 * Helper type to make specific properties required while keeping others optional
 */
export type RequiredOnly<T, K extends keyof T> =
  Required<Pick<T, K>> &
  Partial<Omit<T, K>>;

export type Bindings = {
  ZEPTO_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;

  // OAuth
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;

  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;

  // Storage
  BASE_KV: KVNamespace;
  BASE_DB: D1Database;
  INSTANCE_LOGS: R2Bucket;
  INSTANCE_OBJECT: DurableObjectNamespace;

  // App config
  APP_URL: string;
  BASE_URL: string;
};

export type OAuthProvider = "google" | "github" | "microsoft" | "email";

export type Role = "owner" | "admin" | "developer" | "viewer" | "invited";

export type BootstrapType = "github";

export const integrationIds = ["resendMail", "mailChimp", "mailerSend", "discord", "slack", "gitHub", "gitLab", "bitBucket", "godaddy", "cloudflare", "route53"] as const;

export type IntegrationType = (typeof integrationIds)[number];

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

export interface Session {
  userId: string;
  email: string;
  provider: OAuthProvider;
  clusters: { id: string, name: string, owner: string }[];
  createdAt: number;
  expiresAt: number;
}

export type Variables = {
  user?: User | undefined;
  session?: Session | undefined;
};

export type ActorType = 'user' | 'headless'

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

export interface Instance {
  id: string;
  address: string;
  tag: string;
  metadata?: Record<string, any> | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface Cluster {
  id: string;
  name: string;
  users: string[]; // Array of user emails
  roles: Record<Role, string[]>; // role -> array of user emails
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

export interface ResendMailIntegration { }

export interface ZohoMailIntegration { }

export interface MailerSendIntegration { }

export interface MailChimpIntegration { }

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
    resendMail: ResendMailIntegration,
    zohoMail: ZohoMailIntegration,
    mailerSend: MailerSendIntegration,
    mailChimp: MailChimpIntegration,
  },
  remote: {
    gitHub: GitHubIntegration,
    gitLab: GitLabIntegration,
    bitBucket: BitBucketIntegration,
  },
  notification: {
    discord: DiscordIntegration,
    slack: SlackIntegration,
    customWebhook: CustomWebhookIntegration,
    email: EmailNotificationIntegration,
  }
}

// Export response types
export * from "./responses";

// Export agent types
export * from "./agent";

import type { NotificationEvent } from "@/services/notifier";
