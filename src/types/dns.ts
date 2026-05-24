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
  type: "A" | "AAAA" | "CNAME" | "TXT";
  name: string;
  value: string;
  ttl?: number;
}

export interface DNSSetupResponse {
  domain: string;
  provider: DNSProvider;
  records: DNSRecord[];
  verification: DNSRecord;
  manualGuideUrl: string;
}

export interface CustomDomain {
  id: string;
  clusterId: string;
  serviceName: string | null;
  domain: string;
  status: "pending" | "active";
  verificationToken: string;
  provider: DNSProvider | null;
  createdAt: number;
  activatedAt: number | null;
}
