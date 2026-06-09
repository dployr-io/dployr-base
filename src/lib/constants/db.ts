export const ALLOWED_TABLES = [
  "users",
  "clusters",
  "user_clusters",
  "instances",
  "services",
  "deployments",
  "domains",
  "bootstrap_tokens",
  "billing",
  "service_envs",
  "service_secrets",
  "service_metrics",
  "notifications",
  "api_tokens",
  "oidc_bindings",
] as const

export type AllowedTable = typeof ALLOWED_TABLES[number]

export const TABLE_ID_COLUMNS: Record<AllowedTable, string> = {
  users: "id",
  clusters: "id",
  user_clusters: "user_id",
  instances: "id",
  services: "id",
  deployments: "id",
  domains: "id",
  bootstrap_tokens: "instance_id",
  billing: "cluster_id",
  service_envs: "id",
  service_secrets: "id",
  service_metrics: "service_name",
  notifications: "cluster_id",
  api_tokens: "id",
  oidc_bindings: "id",
}

export const ALLOWED_JSON_FIELDS = [
  "metadata",
] as const

export type AllowedJsonField = typeof ALLOWED_JSON_FIELDS[number]
