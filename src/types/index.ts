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

  // KV Storage
  BASE_KV: KVNamespace;

  // App config
  WEB_URL: string;
  BASE_URL: string;
};

export type OAuthProvider = "google" | "github" | "microsoft" | "email";

export interface OAuthUser {
  email: string;
  name?: string;
  picture?: string;
  provider: OAuthProvider;
}

export interface Session {
  email: string;
  provider: OAuthProvider;
  createdAt: number;
  expiresAt: number;
}

export type Variables = {
  user?: OAuthUser;
  session?: Session;
};

export interface Instance {
  address: string;
  tag: string;
  orgEmail: string; 
  createdAt: number;
  updatedAt: number;
}

export interface Organization {
  email: string;
  name: string;
  users: string[]; // Array of user emails
  roles: Record<string, string[]>; // role -> array of user emails
  createdAt: number;
  updatedAt: number;
}
