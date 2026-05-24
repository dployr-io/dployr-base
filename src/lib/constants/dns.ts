import { DNSProvider } from "@/types/dns.js";

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

