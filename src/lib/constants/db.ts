export const ALLOWED_TABLES = [
  "users",
  "clusters",
  "user_clusters",
  "instances",
  "instance_pool",
  "services",
  "domains",
  "bootstrap_tokens",
  "cluster_subscriptions",
] as const

export type AllowedTable = typeof ALLOWED_TABLES[number]

export const TABLE_ID_COLUMNS: Record<AllowedTable, string> = {
  users: "id",
  clusters: "id",
  user_clusters: "user_id",
  instances: "id",
  instance_pool: "id",
  services: "id",
  domains: "id",
  bootstrap_tokens: "instance_id",
  cluster_subscriptions: "cluster_id",
}

export const ALLOWED_JSON_FIELDS = [
  "metadata",
] as const

export type AllowedJsonField = typeof ALLOWED_JSON_FIELDS[number]
