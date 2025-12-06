// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, existsSync } from 'fs';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

/**
 * Type-safe configuration schema
 */
const ConfigSchema = z.object({
  server: z.object({
    port: z.number().default(7878),
    host: z.string().default('0.0.0.0'),
    base_url: z.url(),
    app_url: z.url(),
  }),
  database: z.object({
    path: z.string().optional(),
    url: z.string().optional(),
    auto_migrate: z.boolean().default(true),
  }),
  kv: z.object({
    type: z.enum(['redis', 'upstash', 'memory']),
    name: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    rest_url: z.string().optional(),
    rest_token: z.string().optional(),
  }),
  storage: z.object({
    type: z.enum(['s3', 'filesystem', 'azure', 'digitalocean']),
    path: z.string().optional(),
    bucket: z.string().optional(),
    region: z.string().optional(),
    access_key: z.string().optional(),
    secret_key: z.string().optional(),
  }),
  auth: z.object({
    google_client_id: z.string().optional(),
    google_client_secret: z.string().optional(),
    github_client_id: z.string().optional(),
    github_client_secret: z.string().optional(),
  }),
  email: z.object({
    provider: z.enum(['zepto', 'resend', 'smtp']),
    zepto_api_key: z.string().optional(),
    smtp_host: z.string().optional(),
    smtp_port: z.number().optional(),
    smtp_user: z.string().optional(),
    smtp_pass: z.string().optional(),
  }),
  security: z.object({
    session_ttl: z.number().default(86400),
    jwt_algorithm: z.string().default('RS256'),
    global_rate_limit: z.number().default(100),
    strict_rate_limit: z.number().default(10),
  }),
  cors: z.object({
    allowed_origins: z.string().optional(),
  }).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate configuration from TOML file or environment variables
 */
export function loadConfig(path?: string): Config {
  // Try environment variables first (for Docker)
  if (process.env.PLATFORM) {
    return loadConfigFromEnv();
  }

  // Fall back to TOML file
  const configPath = path || process.env.CONFIG_PATH || './config.toml';
  
  if (!existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}\nCopy config.example.toml to config.toml and customize it.`);
  }

  const content = readFileSync(configPath, 'utf-8');
  const raw = parseToml(content);
  
  try {
    return ConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errors = err.issues.map((e: any) => `  - ${e.path.join('.')}: ${e.message}`).join('\n');
      throw new Error(`Invalid configuration:\n${errors}`);
    }
    throw err;
  }
}

/**
 * Load configuration from environment variables 
 */
function loadConfigFromEnv(): Config {
  return ConfigSchema.parse({
    server: {
      port: parseInt(process.env.PORT || '7878'),
      host: process.env.HOST || '0.0.0.0',
      base_url: process.env.BASE_URL || 'http://localhost:7878',
      app_url: process.env.APP_URL || 'http://localhost:5173',
    },
    database: {
      url: process.env.DB_URL || process.env.DATABASE_URL,
      auto_migrate: true,
    },
    kv: {
      type: process.env.KV_TYPE || 'redis',
      url: process.env.KV_URL,
      rest_url: process.env.KV_REST_URL,
      rest_token: process.env.KV_REST_TOKEN,
    },
    storage: {
      type: process.env.STORAGE_TYPE || 'filesystem',
      path: process.env.STORAGE_PATH,
      bucket: process.env.STORAGE_BUCKET,
      region: process.env.STORAGE_REGION,
      access_key: process.env.STORAGE_ACCESS_KEY,
      secret_key: process.env.STORAGE_SECRET_KEY,
    },
    auth: {
      google_client_id: process.env.GOOGLE_CLIENT_ID,
      google_client_secret: process.env.GOOGLE_CLIENT_SECRET,
      github_client_id: process.env.GITHUB_CLIENT_ID,
      github_client_secret: process.env.GITHUB_CLIENT_SECRET,
    },
    email: {
      provider: process.env.EMAIL_PROVIDER || 'zepto',
      zepto_api_key: process.env.ZEPTO_API_KEY,
      smtp_host: process.env.SMTP_HOST,
      smtp_port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : undefined,
      smtp_user: process.env.SMTP_USER,
      smtp_pass: process.env.SMTP_PASS,
    },
    security: {
      session_ttl: 86400,
      jwt_algorithm: 'RS256',
      global_rate_limit: 100,
      strict_rate_limit: 10,
    },
    cors: {
      allowed_origins: process.env.CORS_ALLOWED_ORIGINS,
    },
  });
}
