// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export type DNSProvider =
  | "cloudflare"
  | "godaddy"
  | "digitalocean"
  | "route53"
  | "namecheap"
  | "google"
  | "unknown";

export interface DNSRecord {
  type: "A" | "CNAME" | "TXT";
  name: string;
  value: string;
  ttl?: number;
}

export interface DNSSetupResponse {
  domain: string;
  provider: DNSProvider;
  hasOAuth: boolean;
  record: DNSRecord;
  verification: DNSRecord;
  autoSetupUrl: string | null;
  manualGuideUrl: string;
}

export interface OAuthConfig {
  authUrl: string;
  scopes: string;
  clientIdEnvKey: string;
}

export interface CustomDomain {
  id: string;
  instanceId: string;
  domain: string;
  status: "pending" | "active";
  verificationToken: string;
  provider: DNSProvider | null;
  createdAt: number;
  activatedAt: number | null;
}
