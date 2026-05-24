// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DNSProvider, DNSRecord } from "@/types/dns.js";
import type { Bindings } from "@/types/index.js";
import { ulid } from "ulid";
import { detectProvider, checkTxtRecord } from "@/lib/dns/provider.js";
import { MANUAL_GUIDES } from "@/lib/constants/dns.js";
import { DNS_RECORD_TTL } from "@/lib/constants/duration.js";

export class DnsService {
  constructor(private env: Bindings) {}

  /**
   * Detects the DNS provider for a domain
   */
  async detectProvider(domain: string): Promise<DNSProvider> {
    return detectProvider(domain);
  }

  /**
   * Verifies a DNS TXT record for domain ownership
   */
  async checkTxtRecord(domain: string, token: string): Promise<boolean> {
    return checkTxtRecord(domain, token);
  }

  /**
   * Generates a new verification token for domain setup.
   * Should only be called once when creating a new domain record.
   */
  generateToken(): string {
    return ulid();
  }

  /**
   * Builds DNS records for a custom domain.
   * - Apex domain (e.g. myapp.com): A record → reserved IPv4, AAAA record → reserved IPv6
   * - Subdomain (e.g. www.myapp.com): CNAME → serviceName.tld
   * Always includes a TXT verification record.
   */
  buildRecordsFromStored(domain: string, serviceName: string | null, verificationToken: string): { records: DNSRecord[]; verification: DNSRecord } {
    const parts = domain.split(".");
    const isApex = parts.length === 2;
    const tld = this.env.TRAEFIK_TLD ?? "dployr.run";

    const records: DNSRecord[] = [];

    if (isApex) {
      if (this.env.TRAEFIK_IPV4) {
        records.push({ type: "A", name: "@", value: this.env.TRAEFIK_IPV4, ttl: DNS_RECORD_TTL });
      }
      if (this.env.TRAEFIK_IPV6) {
        records.push({ type: "AAAA", name: "@", value: this.env.TRAEFIK_IPV6, ttl: DNS_RECORD_TTL });
      }
    } else {
      const subdomain = parts[0];
      const cnameTarget = serviceName ? `${serviceName}.${tld}` : tld;
      records.push({ type: "CNAME", name: subdomain, value: cnameTarget, ttl: DNS_RECORD_TTL });
    }

    return {
      records,
      verification: {
        type: "TXT",
        name: "_dployr",
        value: `dployr-verify=${verificationToken}`,
      },
    };
  }

  /**
   * Gets the manual setup guide URL for a DNS provider
   */
  getManualGuideUrl(provider: DNSProvider): string {
    return MANUAL_GUIDES[provider];
  }
}
