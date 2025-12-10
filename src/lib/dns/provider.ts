// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DNSProvider } from "@/types/dns.js";
import { NS_PATTERNS, OAUTH_SUPPORTED } from "@/lib/constants/domain-configs.js";

/**
 * Detects the DNS provider for a domain by querying NS records
 */
export async function detectProvider(domain: string): Promise<{
  provider: DNSProvider;
  hasOAuth: boolean;
}> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`,
      { headers: { Accept: "application/dns-json" } }
    );

    if (!res.ok) throw new Error("DNS lookup failed");

    const data = (await res.json()) as { Answer?: { data: string }[] };
    const nsRecords = data.Answer?.map(a => a.data.toLowerCase()) || [];

    for (const ns of nsRecords) {
      for (const [pattern, provider] of Object.entries(NS_PATTERNS)) {
        if (ns.includes(pattern)) {
          return { provider, hasOAuth: OAUTH_SUPPORTED.includes(provider) };
        }
      }
    }
  } catch (err) {
    console.error("Provider detection failed:", err);
  }

  return { provider: "unknown", hasOAuth: false };
}

/**
 * Verifies a DNS TXT record for domain ownership
 */
export async function checkTxtRecord(domain: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=_dployr.${encodeURIComponent(domain)}&type=TXT`,
      { headers: { Accept: "application/dns-json" } }
    );

    if (!res.ok) return false;

    const data = (await res.json()) as { Answer?: { data: string }[] };
    return data.Answer?.some(a => a.data.replace(/"/g, "").includes(token)) ?? false;
  } catch {
    return false;
  }
}
