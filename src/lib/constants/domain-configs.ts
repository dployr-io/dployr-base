import { DNSProvider, OAuthConfig } from "@/types/dns.js";

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

export const NS_PATTERNS: Record<string, DNSProvider> = {
  "cloudflare.com": "cloudflare",
  "godaddy.com": "godaddy",
  "digitalocean.com": "digitalocean",
  "awsdns": "route53",
  "registrar-servers.com": "namecheap",
  "googledomains.com": "google",
  "google.com": "google",
};

export const OAUTH_SUPPORTED: DNSProvider[] = ["cloudflare", "godaddy", "digitalocean", "google"];
