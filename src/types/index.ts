// types/index.ts
export type Bindings = {
  ZEPTO_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;

  // OAuth
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APPLE_CLIENT_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;

  // KV Storage
  BASE_KV: KVNamespace;

  // App config
  DPLOYR_WEB_URL: string;
  DPLOYR_BASE_URL: string;
};

export type OAuthProvider = "google" | "apple" | "microsoft";

export interface OAuthUser {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  provider: OAuthProvider;
}

export interface Session {
  userId: string;
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
  id: string;
  address: string;
  tag: string;
  orgId: string;
  createdAt: number;
  updatedAt: number;
}

export interface Organization {
  id: string;
  name: string;
  users: string[]; // Array of user IDs
  roles: Record<string, string[]>; // role -> array of user IDs
  createdAt: number;
  updatedAt: number;
}
