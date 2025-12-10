// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DNSProvider } from "@/types/dns.js";

interface OAuthConfig {
  authUrl: string;
  scopes: string;
  clientIdEnvKey: string;
}

export const OAUTH_CONFIGS: Partial<Record<DNSProvider, OAuthConfig>> = {
  cloudflare: {
    authUrl: "https://dash.cloudflare.com/oauth2/authorize",
    scopes: "zone:read zone:edit",
    clientIdEnvKey: "CLOUDFLARE_CLIENT_ID",
  },
  godaddy: {
    authUrl: "https://sso.godaddy.com/authorize",
    scopes: "domain:dns:write",
    clientIdEnvKey: "GODADDY_CLIENT_ID",
  },
  digitalocean: {
    authUrl: "https://cloud.digitalocean.com/v1/oauth/authorize",
    scopes: "write",
    clientIdEnvKey: "DIGITALOCEAN_CLIENT_ID",
  },
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scopes: "https://www.googleapis.com/auth/ndev.clouddns.readwrite",
    clientIdEnvKey: "GOOGLE_DNS_CLIENT_ID",
  },
};

export const MANUAL_GUIDES: Record<DNSProvider, string> = {
  cloudflare: "https://docs.dployr.io/domains/cloudflare",
  godaddy: "https://docs.dployr.io/domains/godaddy",
  digitalocean: "https://docs.dployr.io/domains/digitalocean",
  route53: "https://docs.dployr.io/domains/route53",
  namecheap: "https://docs.dployr.io/domains/namecheap",
  google: "https://docs.dployr.io/domains/google",
  unknown: "https://docs.dployr.io/domains/manual",
};

export function buildOAuthUrl(
  provider: DNSProvider,
  state: string,
  baseUrl: string,
  env: Record<string, string>
): string | null {
  const config = OAUTH_CONFIGS[provider];
  if (!config) return null;

  const clientId = env[config.clientIdEnvKey];
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${baseUrl}/v1/dns/callback/${provider}`,
    response_type: "code",
    scope: config.scopes,
    state,
  });

  return `${config.authUrl}?${params}`;
}

export function getManualGuideUrl(provider: DNSProvider): string {
  return MANUAL_GUIDES[provider];
}
