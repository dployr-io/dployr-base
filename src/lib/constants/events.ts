export const EVENTS = {
  AUTH: {
    SESSION_CREATED: { code: "auth.session_created", message: "Sign-in successful" },
  },
  CLUSTER: {
    MODIFIED: { code: "cluster.modified", message: "Cluster modified successfully" },
    USER_INVITED: { code: "cluster.user_invited", message: "Successfully sent invite" },
    INVITE_REVOKED: { code: "cluster.invite_revoked", message: "Revoked invite to join cluster successfully" },
    INVITE_ACCEPTED: { code: "cluster.invite_accepted", message: "Accepted invite to join cluster" },
    INVITE_DECLINED: { code: "cluster.invite_declined", message: "Declined invite to join cluster" },
    REMOVED_USER: { code: "cluster.removed_user", message: "Removed user from cluster" },
    USER_ROLE_CHANGED: { code: "cluster.user_role_changed", message: "User role changed" },
    OWNERSHIP_TRANSFERRED: { code: "cluster.ownership_transferred", message: "Cluster ownership transferred" },
  },
  BILLING: {
    PAYMENT_SUCCESSFUL: { code: "billing.payment_successful", message: "Payment successful" },
    PAYMENT_FAILED: { code: "billing.payment_failed", message: "Payment failed" },
    SUBSCRIPTION_RESUMED: { code: "billing.subscription_canceled", message: "Your subscription has been resumed" },
    SUBSCRIPTION_CANCELLED: { code: "billing.subscription_canceled", message: "Your subscription has been cancelled" },
    SUBSCRIPTION_EXPIRED: { code: "billing.subscription_expired", message: "Your subscription has expired" },
  },
  INSTANCE: {
    CREATED: { code: "instance.created", message: "Instance created successfully" },
    MODIFIED: { code: "instance.modified", message: "Instance modified successfully" },
    DELETED: { code: "instance.deleted", message: "Instance deleted successfully" },
  },
  PERMISSION: {
    OWNER_ACCESS_GRANTED: { code: "permission.owner_access_granted", message: "Owner access granted" },
    ADMIN_ACCESS_GRANTED: { code: "permission.admin_access_granted", message: "Admin access granted" },
    WRITE_ACCESS_GRANTED: { code: "permission.write_access_granted", message: "Write access granted" },
    READ_ACCESS_GRANTED: { code: "permission.read_access_granted", message: "Read access granted" },
  },
  RESOURCE: {
    RESOURCE_CREATED: { code: "resource.resource_created", message: "Resource created successfully" },
    RESOURCE_UPDATED: { code: "resource.resource_updated", message: "Resource updated successfully" },
    RESOURCE_DELETED: { code: "resource.resource_deleted", message: "Resource deleted successfully" },
  },
  BOOTSTRAP: {
    BOOTSTRAP_SETUP_COMPLETED: { code: "bootstrap.bootstrap_setup_completed", message: "Bootstrap setup completed successfully" },
    BOOTSTRAP_RUN_STARTED: { code: "bootstrap.bootstrap_run_started", message: "Bootstrap run initiated" },
    BOOTSTRAP_RUN_COMPLETED: { code: "bootstrap.bootstrap_run_completed", message: "Bootstrap run completed successfully" },
  },
  RUNTIME: {
    WEBHOOK_RECEIVED: { code: "runtime.webhook_received", message: "Webhook received successfully" },
    WEBHOOK_PROCESSED: { code: "runtime.webhook_processed", message: "Webhook processed successfully" },
  },
  INTEGRATIONS: {
    GITHUB_INSTALLED: { code: "integrations.github_installed", message: "GitHub integration setup successfully" },
  },
  READ: {
    BOOTSTRAP_LOGS: { code: "read.bootstrap_logs", message: "Bootstrap logs read" },
  },
} as const;

export const DEFAULT_EVENTS = [
  EVENTS.INSTANCE.CREATED.code,
  EVENTS.INSTANCE.MODIFIED.code,
  EVENTS.INSTANCE.DELETED.code,
  EVENTS.CLUSTER.INVITE_ACCEPTED.code,
  EVENTS.CLUSTER.USER_INVITED.code,
  EVENTS.CLUSTER.REMOVED_USER.code,
  EVENTS.CLUSTER.USER_ROLE_CHANGED.code,
];
