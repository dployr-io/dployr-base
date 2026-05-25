// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export function generateSecretKey({ length = 32, encoding = "hex" }: { length?: number; encoding?: "hex" | "base64" | "base64url" }): string {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);

  if (encoding === "hex") {
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } else if (encoding === "base64") {
    return btoa(String.fromCharCode(...buffer));
  } else {
    return btoa(String.fromCharCode(...buffer))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }
}

export async function verifyGitHubWebhook({ payload, signature, secret }: { payload: string; signature: string; secret: string }): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  const digest = `sha256=${Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  return signature === digest;
}

/** enforce same-origin/local paths to avoid open-redirects */
export function sanitizeReturnTo(returnTo: string) {
  try {
    if (returnTo.startsWith("/")) return returnTo;
    const url = new URL(returnTo);
    // TODO: use env
    if (url.origin === "https://app.dployr.io") return url.pathname + url.search + url.hash;
  } catch (e) {
    /* ignore */
  }
  return "/dashboard";
}

/** Convert a numeric timestamp (ms) or ISO string to ISO string, falling back to now. */
export function toISO(value: number | string | null | undefined): string {
  if (value == null) return new Date().toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Normalizes a health check path to the canonical form: /foo/bar
 *
 * Accepts:
 *   A.  foo/bar      → /foo/bar
 *   B.  /foo/bar     → /foo/bar  (already canonical)
 *   C.  /foo/bar/    → /foo/bar
 *
 * Returns `/` for empty/whitespace-only input.
 */
export function normalizeHealthCheckPath(raw: string | null | undefined): string {
  const fallback = "/";
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  // Strip trailing slashes; if nothing remains (e.g. bare "/"), return null
  let p = trimmed.replace(/\/+$/, "");
  if (!p) return fallback;

  // Ensure exactly one leading slash
  if (!p.startsWith("/")) p = "/" + p;

  return p;
}
