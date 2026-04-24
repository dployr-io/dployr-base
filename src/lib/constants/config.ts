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
  }),
  kv: z.object({
    type: z.enum(["redis", "upstash", "memory"]),
    name: z.string().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
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
    admin_api_key: z.string(),
    allowed_ips: z.array(z.string()),
    totp_secret: z.string(),
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
          indie: z.string().url().optional(),
          pro: z.string().url().optional(),
        })
        .optional(),
    })
    .optional(),
  proxy: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().default(8080),
      host: z.string().default("0.0.0.0"),
      base_domain: z.string().default("dployr.io"),
      timeout_ms: z.number().default(30000),
      cache_ttl_seconds: z.number().default(30),
    })
    .optional(),
  virtual_machines: z
    .object({
      provider: z.enum(["digitalocean"]).default("digitalocean"),
      do_api_token: z.string().optional(),
    })
    .optional(),
});