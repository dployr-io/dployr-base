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
  TURNSTILE_SECRET_KEY?: string;

  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_ENVIRONMENT?: string;
  BILLING_PRODUCT_IDS?: { indie_monthly?: string; indie_annual?: string; pro_monthly?: string; pro_annual?: string };

  DO_API_TOKEN?: string;
  SSH_KEY?: number;
  REGISTRY_URL?: string;
  REGISTRY_AUTH?: string;

  TRAEFIK_ENABLED?: boolean;
  TRAEFIK_TLD?: string;
  TRAEFIK_IPV4?: string;
  TRAEFIK_IPV6?: string;

  LISTMONK_URL?: string;
  LISTMONK_ADMIN_USER?: string;
  LISTMONK_ADMIN_PASSWORD?: string;
  LISTMONK_LIST_UUID?: string;
  LISTMONK_BOUNCE_WEBHOOK_SECRET?: string;
};
