// types/index.ts
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

  // Storage
  BASE_KV: KVNamespace;
  BASE_DB: D1Database;

  // App config
  WEB_URL: string;
  BASE_URL: string;
};

export type OAuthProvider = "google" | "github" | "microsoft" | "email";

export type Role = "owner" | "admin" | "developer" | "viewer";

export interface User {
  id: string;
  email: string;
  name?: string | undefined;
  picture?: string | undefined;
  provider: OAuthProvider;
  metadata?: Record<string, any> | undefined
  created_at: number;
  updated_at: number;
}

export interface Session {
  email: string;
  provider: OAuthProvider;
  clusters: string[],
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
  tag: string;
  metadata?: Record<string, any> | undefined
  createdAt: number;
  updatedAt: number;
}

export interface Cluster {
  id: string;
  name: string;
  users: string[]; // Array of user emails
  roles: Record<Role, string[]>; // role -> array of user emails
  metadata?: Record<string, any> | undefined
  createdAt: number;
  updatedAt: number;
}
