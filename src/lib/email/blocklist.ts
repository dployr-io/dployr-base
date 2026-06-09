// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@/lib/logger.js";

const log = new Logger("EmailBlocklist");

const BLOCKLIST_URL =
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/refs/heads/main/disposable_email_blocklist.conf";
const TTL_MS = 24 * 60 * 60 * 1000;

let cache: Set<string> | null = null;
let lastFetch = 0;

/** Resets the in-memory cache. Only for use in tests. */
export function _resetCache() {
  cache = null;
  lastFetch = 0;
}

/**
 * Returns the cached blocklist, refreshing from the upstream source if the
 * cache is absent or older than 24 hours. Falls back to the last known good
 * cache (or an empty set) if the fetch fails.
 */
async function getBlocklist(): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - lastFetch < TTL_MS) return cache;

  try {
    const res = await fetch(BLOCKLIST_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const domains = text
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"));
    cache = new Set(domains);
    lastFetch = now;
    log.info(`Loaded ${cache.size} blocked email domains`);
  } catch (err) {
    log.error("Failed to fetch disposable email blocklist:", err);
    if (!cache) cache = new Set();
  }

  return cache;
}

/**
 * Returns true if the email address uses a known disposable/throwaway domain.
 *
 * Domains are checked against the disposable-email-domains blocklist, which is
 * fetched once and cached in memory for 24 hours. Unknown or custom domains
 * (e.g. `@acme.org`) are allowed through.
 *
 * @param email - The full email address to check (e.g. "user@mailinator.com")
 */
export async function isDisposableEmail(email: string): Promise<boolean> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  const blocklist = await getBlocklist();
  return blocklist.has(domain);
}
