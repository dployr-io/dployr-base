import { z } from "zod";

/**
 * Type-safe configuration schema
 */
export const CONFIG_SCHEMA = z.object({
  server: z.object({
    port: z.number().default(7878),
    host: z.string().default("0.0.0.0"),
    base_url: z.url(),
    app_url: z.url(),
  }),
  database: z.object({
    path: z.string().optional(),
    url: z.string().optional(),
    auto_migrate: z.boolean().default(true),
    /**
     * Max connections in the pool per process.
     * Multiply by replica count to get total DB connections. Default: 20.
     */
    pool_max: z.number().int().positive().default(20),
    /**
     * Minimum idle connections kept warm. Avoids cold-start latency after quiet periods. Default: 2.
     */
    pool_min: z.number().int().nonnegative().default(2),
    /**
     * Milliseconds before an idle connection is released back to the OS. Default: 10000.
     */
    pool_idle_timeout_ms: z.number().int().positive().default(10_000),
    /**
     * Milliseconds to wait for a free connection before throwing. Raise this if you see
     * timeout errors under traffic spikes. Default: 5000.
     */
    pool_connection_timeout_ms: z.number().int().positive().default(5_000),
    /**
     * Enable TCP keep-alive probes. Prevents silently stale connections on cloud hosts
     * (RDS, Supabase, Railway, etc.) that close idle TCP connections. Default: true.
     */
    pool_keep_alive: z.boolean().default(true),
    /**
     * SSL mode for the database connection:
     * - `false`       — no SSL (local development)
     * - `true`        — SSL with certificate verification (recommended for production)
     * - `"no-verify"` — SSL without certificate verification (self-signed certs / some managed hosts)
     *
     * Default: false. Set to `true` in any environment where the connection crosses a network.
     */
    pool_ssl: z.union([z.boolean(), z.literal("no-verify"), z.literal("disable")]).default(false),
  }),
  kv: z.object({
    type: z.enum(["redis", "upstash", "memory"]),
    name: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    url: z.string().optional(),
    rest_url: z.string().optional(),
    rest_token: z.string().optional(),
  }),
  storage: z.object({
    type: z.enum(["s3", "filesystem", "azure", "digitalocean"]),
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
    microsoft_client_id: z.string().optional(),
    microsoft_client_secret: z.string().optional(),
  }),
  admin: z.object({
    admin_api_key: z.string().optional().default(""),
    allowed_ips: z.array(z.string()).default([]),
    totp_secret: z.string().optional().default(""),
    metrics_scrape_token: z.string().optional(),
  }),
  integrations: z
    .object({
      github_app_id: z.string().optional(),
      github_app_private_key: z.string().optional(),
      github_webhook_secret: z.string().optional(),
      github_token: z.string().optional(),
      gitlab_app_id: z.string().optional(),
      gitlab_app_secret: z.string().optional(),
      bitbucket_app_id: z.string().optional(),
      bitbucket_app_secret: z.string().optional(),
    })
    .optional(),
  email: z
    .object({
      provider: z.enum(["zepto", "resend", "smtp"]),
      zepto_api_key: z.string().optional(),
      from_address: z.email().optional(),
      smtp_host: z.string().optional(),
      smtp_port: z.number().optional(),
      smtp_user: z.string().optional(),
      smtp_pass: z.string().optional(),
    })
    .superRefine((val, ctx) => {
      if (val.provider === "zepto" && val.zepto_api_key && !val.from_address) {
        ctx.addIssue({
          code: "custom",
          path: ["from_address"],
          message: "email.from_address is required when using Zepto with a non-empty zepto_api_key",
        });
      }
    }),
  security: z.object({
    session_ttl: z.number().default(86400),
    jwt_algorithm: z.string().default("RS256"),
    global_rate_limit: z.number().default(100),
    strict_rate_limit: z.number().default(10),
    /**
     * Hex-encoded 32-byte AES-256-GCM key used as the KEK (key-encrypting key) for service secrets.
     * Generate with: openssl rand -hex 32
     * Can also be set via the ENCRYPTION_KEY environment variable.
     */
    encryption_key: z.string().length(64).optional(),
  }),
  cors: z
    .object({
      allowed_origins: z.string().optional(),
    })
    .optional(),
  billing: z
    .object({
      provider: z.enum(["polar"]).default("polar"),
      polar_access_token: z.string().optional(),
      polar_webhook_secret: z.string().optional(),
      environment: z.enum(["sandbox", "production"]).default("sandbox"),
      checkout_urls: z
        .object({
          indie: z.url().optional(),
          pro: z.url().optional(),
        })
        .optional(),
    })
    .optional(),
  traefik: z
    .object({
      enabled: z.boolean().default(false),
      tld: z.string().default("dployr.run"),
      ipv4: z.string().optional(),
      ipv6: z.string().optional(),
      redis_url: z.string().optional(),
      redis_host: z.string().optional(),
      redis_port: z.number().int().positive().optional(),
      redis_username: z.string().optional(),
      redis_password: z.string().optional(),
      metrics_url: z.string().optional(),
    })
    .optional(),
  virtual_machines: z
    .object({
      provider: z.enum(["digitalocean"]).default("digitalocean"),
      do_api_token: z.string().optional(),
      ssh_key: z.number().int().positive().optional(),
      build_nodes: z.number().int().min(0).default(1),
    })
    .optional(),
  registry: z
    .object({
      url: z.string().optional(),
      auth: z.string().optional(),
    })
    .optional(),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).optional(),
}).superRefine((val, ctx) => {
  const isTest = process.env.NODE_ENV === "test";

  if (!isTest && (!val.traefik?.enabled)) {
    ctx.addIssue({
      code: "custom",
      path: ["traefik"],
      message: "traefik.enabled must be true in non-test environments",
    });
  }
});