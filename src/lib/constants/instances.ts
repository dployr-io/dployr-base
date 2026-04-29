// Instance pool quota
export const INSTANCE_POOL_QUOTA = 8;

// Instance regions
export const INSTANCE_REGIONS = ["us-east", "us-west", "us-central", "eu-west", "eu-central", "eu-north", "ap-south", "ap-southeast", "ap-northeast", "af-south", "me-central", "sa-east"] as const;

// Allowed tasks on pooled instances
export const ALLOWED_TASKS_ON_POOLED_INSTANCES = ["deployments", "services", "log_subscribe", "log_unsubscribe"];
