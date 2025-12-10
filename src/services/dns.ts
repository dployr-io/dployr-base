// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DNSProvider, DNSRecord } from "@/types/dns.js";
import type { Bindings } from "@/types/index.js";
import { ulid } from "ulid";
import { detectProvider, checkTxtRecord } from "@/lib/dns/provider.js";
import { MANUAL_GUIDES, OAUTH_CONFIGS } from "@/lib/constants/domain-configs.js";

export class DNSService {
  constructor(private env: Bindings) {}

  /**
   * Detects the DNS provider for a domain
   */
  async detectProvider(domain: string): Promise<{
    provider: DNSProvider;
    hasOAuth: boolean;
  }> {
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
   * Builds DNS records from stored domain data.
   * Uses A record pointing directly to instance IP address.
   */
  buildRecordsFromStored(
    domain: string,
    instanceAddress: string,
    verificationToken: string
  ): { record: DNSRecord; verification: DNSRecord } {
    const parts = domain.split(".");
    const name = parts.length > 2 ? parts[0] : "@";

    return {
      record: {
        type: "A",
        name,
        value: instanceAddress,
        ttl: 300,
      },
      verification: {
        type: "TXT",
        name: "_dployr",
        value: `dployr-verify=${verificationToken}`,
      },
    };
  }

  /**
   * Builds OAuth URL for DNS provider setup
   */
  buildOAuthUrl(
    provider: DNSProvider,
    state: string,
    baseUrl: string
  ): string | null {
    const config = OAUTH_CONFIGS[provider];
    if (!config) return null;

    const clientId = this.env[config.clientIdEnvKey as keyof Bindings];
    if (!clientId) return null;

    const params = new URLSearchParams({
      client_id: clientId as string,
      redirect_uri: `${baseUrl}/v1/dns/callback/${provider}`,
      response_type: "code",
      scope: config.scopes,
      state,
    });

    return `${config.authUrl}?${params}`;
  }

  /**
   * Gets the manual setup guide URL for a DNS provider
   */
  getManualGuideUrl(provider: DNSProvider): string {
    return MANUAL_GUIDES[provider];
  }
}
