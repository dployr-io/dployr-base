// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "@/types/index.js";
import { createErrorResponse } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { getKV } from "@/lib/config/context.js";

/**
 * Configuration options for the rate limit middleware.
 */
interface RateLimitConfig {
  /** Time window in milliseconds (e.g., 60_000 for 1 minute) */
  windowMs: number;
  /** Maximum allowed requests within the window */
  maxRequests: number;
  /** Prefix for the KV store key (e.g., "ratelimit:global") */
  keyPrefix: string;
}

/**
 * Rate limit middleware with per-second bucket sliding window.
 *
 * Uses a sliding window with per-second buckets to reduce race conditions.
 * Each bucket key format: ratelimit:{prefix}:{identifier}:{windowBucket}
 * where windowBucket = Math.floor(Date.now() / 1000)
 *
 * Note: This implementation still has a small race window between get and put operations.
 * For true atomicity, Redis INCR + EXPIRE should be used. The MemoryKV and Redis adapters
 * would need native increment support (INCR) for strict enforcement.
 */
export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const userId = c.get("session")?.userId;
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

    const identifier = userId || ip;
    const currentBucket = Math.floor(Date.now() / 1000);
    const key = `ratelimit:${config.keyPrefix}:${identifier}:${currentBucket}`;

    try {
      const kv = getKV(c);
      const now = Date.now();
      const windowStart = now - config.windowMs;

      const data = await kv.get(key);
      let count = data ? parseInt(data, 10) : 0;

      if (count >= config.maxRequests) {
        const oldestTimestamp = currentBucket;
        const retryAfter = Math.ceil(oldestTimestamp + Math.ceil(config.windowMs / 1000) - now / 1000);

        return c.json(
          createErrorResponse({
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            code: ERROR.REQUEST.TOO_MANY_REQUESTS.code,
          }),
          {
            status: ERROR.REQUEST.TOO_MANY_REQUESTS.status,
            headers: {
              "Retry-After": String(Math.max(1, retryAfter)),
              "X-RateLimit-Limit": String(config.maxRequests),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(currentBucket + Math.ceil(config.windowMs / 1000)),
            },
          },
        );
      }

      count++;
      const ttlSeconds = Math.ceil(config.windowMs / 1000) * 2;
      await kv.put(key, String(count), {
        ttl: ttlSeconds,
      });

      c.header("X-RateLimit-Limit", String(config.maxRequests));
      c.header("X-RateLimit-Remaining", String(config.maxRequests - count));
      c.header("X-RateLimit-Reset", String(currentBucket + Math.ceil(config.windowMs / 1000)));

      await next();
    } catch (error) {
      console.error("[Middleware] Rate limit check failed:", error);
      await next();
    }
  };
}

/**
 * Per-user global rate limit (across all endpoints).
 * 100 requests per minute per user/IP. Uses key prefix "ratelimit:global".
 */
export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100, // 100 requests per minute per user
  keyPrefix: "ratelimit:global",
});

/**
 * Strict rate limit for sensitive administrative endpoints.
 * 10 requests per minute per user/IP. Uses key prefix "ratelimit:strict".
 */
export const strictRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // 10 requests per minute
  keyPrefix: "ratelimit:strict",
});

/**
 * Lenient rate limit for read-only or public endpoints.
 * 200 requests per minute per user/IP. Uses key prefix "ratelimit:lenient".
 */
export const lenientRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 200, // 200 requests per minute
  keyPrefix: "ratelimit:lenient",
});
