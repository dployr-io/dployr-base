// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "@/types";
import { createErrorResponse } from "@/types";
import { ERROR } from "@/lib/constants";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

/**
 * Rate limit middleware using Cloudflare KV
 * 
 * @param config - Rate limit configuration
 * @returns Hono middleware function
 */
export function rateLimit(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const userId = c.get("session")?.userId;
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
    
    // Use userId if authenticated, otherwise use IP
    const identifier = userId || ip;
    const key = `${config.keyPrefix}:${identifier}`;
    
    try {
      const kv = c.env.BASE_KV;
      const now = Date.now();
      const windowStart = now - config.windowMs;
      
      // Get request timestamps from KV
      const data = await kv.get(key);
      let timestamps: number[] = data ? JSON.parse(data) : [];
      
      // Remove timestamps outside the current window
      timestamps = timestamps.filter(ts => ts > windowStart);
      
      // Check if rate limit exceeded
      if (timestamps.length >= config.maxRequests) {
        const oldestTimestamp = Math.min(...timestamps);
        const retryAfter = Math.ceil((oldestTimestamp + config.windowMs - now) / 1000);
        
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
              "X-RateLimit-Reset": String(Math.ceil((oldestTimestamp + config.windowMs) / 1000)),
            },
          }
        );
      }
      
      // Add current timestamp
      timestamps.push(now);
      
      // Store updated timestamps with TTL slightly longer than window
      await kv.put(key, JSON.stringify(timestamps), {
        expirationTtl: Math.ceil(config.windowMs / 1000) + 60,
      });
      
      // Set rate limit headers
      c.header("X-RateLimit-Limit", String(config.maxRequests));
      c.header("X-RateLimit-Remaining", String(config.maxRequests - timestamps.length));
      c.header("X-RateLimit-Reset", String(Math.ceil((now + config.windowMs) / 1000)));
      
      await next();
    } catch (error) {
      console.error("Rate limit check failed:", error);
      // Fail open - allow request if rate limiting fails
      await next();
    }
  };
}

/**
 * Per-user global rate limit (across all endpoints)
 */
export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100, // 100 requests per minute per user
  keyPrefix: "ratelimit:global",
});

/**
 * Strict rate limit for sensitive endpoints
 */
export const strictRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 10, // 10 requests per minute
  keyPrefix: "ratelimit:strict",
});

/**
 * Lenient rate limit for read-only endpoints
 */
export const lenientRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 200, // 200 requests per minute
  keyPrefix: "ratelimit:lenient",
});
