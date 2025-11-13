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

  // App config
  APP_URL: string;
  BASE_URL: string;
};

export type OAuthProvider = "google" | "github" | "microsoft" | "email";

export type Role = "owner" | "admin" | "developer" | "viewer" | "invited";

export type BootstrapType = "github";

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
  clusters: string[];
  createdAt: number;
  expiresAt: number;
}

export type Variables = {
  user?: User | undefined;
  session?: Session | undefined;
};

export interface Instance {
  id: string;
  address: string;
  publicKey: string;
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
  bootstrapId: number | null;
  metadata?: Record<string, any> | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface Bootstrap {
  id: number;
  type: BootstrapType;
  createdAt: number;
}

// Export response types
export * from "./responses";
