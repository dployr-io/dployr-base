// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

/**
 * Check if an origin is allowed based on configured patterns
 */
function isOriginAllowed(origin: string, patterns: string[]): boolean {
  const host = origin
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  return patterns.some((pattern: string) => {
    if (pattern.startsWith("*.") && pattern.length > 2) {
      const domain = pattern.slice(2);
      return host === domain || host.endsWith(`.${domain}`);
    }

    const normalizedPatternHost = pattern
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    return host === normalizedPatternHost;
  });
}

/**
 * Parse CORS allowed origins from config string
 */
function parseAllowedOrigins(raw: string): string[] {
  const patterns = raw
    .split(",")
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);

  // Always allow *.dployr.io by default
  if (!patterns.includes("*.dployr.io")) {
    patterns.push("*.dployr.io");
  }

  return patterns;
}

/**
 * Create CORS middleware with dynamic origin validation
 */
export function createCorsMiddleware(getConfig: () => { allowed_origins?: string } | undefined): MiddlewareHandler {
  return cors({
    origin: (origin) => {
      const corsConfig = getConfig();
      const raw = corsConfig?.allowed_origins || process.env.CORS_ALLOWED_ORIGINS;
      
      if (!raw) {
        console.error("CORS allowed origins are not configured; refusing cross-origin requests.");
        console.error("Debug: corsConfig =", JSON.stringify(corsConfig));
        console.error("Debug: process.env.CORS_ALLOWED_ORIGINS =", process.env.CORS_ALLOWED_ORIGINS);
        return null;
      }

      if (!origin) {
        console.warn("CORS check received request with no Origin header; skipping CORS.");
        return null;
      }

      const patterns = parseAllowedOrigins(raw);
      const isAllowed = isOriginAllowed(origin, patterns);

      if (!isAllowed) {
        console.warn(`CORS origin not allowed: ${origin}`);
        return null;
      }

      return origin;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  });
}
