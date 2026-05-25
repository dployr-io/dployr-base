/**
 * Helper type to make specific properties required while keeping others optional
 */
export type Bindings = {
  ZEPTO_API_KEY: string;

  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;

  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;

  APP_URL: string;
  BASE_URL: string;
  TLD?: string;
  EMAIL_FROM?: string;
  CORS_ALLOWED_ORIGINS?: string;
  ENCRYPTION_KEY: string;

  ADMIN_API_KEY: string;
  ALLOWED_DPLOYR_ADMINISTRATORS: string;
  ADMIN_TOTP_SECRET: string;
  METRICS_SCRAPE_TOKEN?: string;

  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_ENVIRONMENT?: string;
  BILLING_PRODUCT_IDS?: Record<string, string>;

  DO_API_TOKEN?: string;
  SSH_KEY?: number;
  REGISTRY_URL?: string;
  REGISTRY_AUTH?: string;

  TRAEFIK_ENABLED?: boolean;
  TRAEFIK_TLD?: string;
  TRAEFIK_IPV4?: string;
  TRAEFIK_IPV6?: string;
};
