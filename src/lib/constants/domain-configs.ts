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
  cloudflare: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/",
  godaddy: "https://www.godaddy.com/en-ph/help/manage-dns-records-680",
  digitalocean: "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/",
  route53: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
  namecheap: "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-do-i-add-or-edit-dns-records/",
  google: "https://cloud.google.com/dns/docs/records",
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
