// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "@/types/index.js";
import { createErrorResponse } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { getKV } from "@/lib/config/context.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("RateLimit");

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
 * Rate limit middleware using atomic fixed-window counters.
 *
 * Each window is keyed by floor(now / windowMs). */
export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const userId = c.get("session")?.userId;
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

    const identifier = userId || ip;
    const windowSizeMs = config.windowMs;
    const windowSizeSec = Math.ceil(windowSizeMs / 1000);
    const currentWindow = Math.floor(Date.now() / windowSizeMs);
    const key = `ratelimit:${config.keyPrefix}:${identifier}:${currentWindow}`;
    const resetAt = (currentWindow + 1) * windowSizeSec;

    try {
      const kv = getKV(c);
      const count = await kv.incr(key, windowSizeSec * 2);

      if (count > config.maxRequests) {
        const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
        return c.json(
          createErrorResponse({
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            code: ERROR.REQUEST.TOO_MANY_REQUESTS.code,
          }),
          {
            status: ERROR.REQUEST.TOO_MANY_REQUESTS.status,
            headers: {
              "Retry-After": String(retryAfter),
              "X-RateLimit-Limit": String(config.maxRequests),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(resetAt),
            },
          },
        );
      }

      c.header("X-RateLimit-Limit", String(config.maxRequests));
      c.header("X-RateLimit-Remaining", String(Math.max(0, config.maxRequests - count)));
      c.header("X-RateLimit-Reset", String(resetAt));

      await next();
    } catch (error) {
      log.error("Rate limit check failed:", error);
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
