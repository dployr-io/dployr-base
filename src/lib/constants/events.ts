import { EventMetadataMap } from "@/services/notifications/notifier.js";

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
  POOL: {
    INSTANCE_MAINTENANCE: { code: "pool.instance_maintenance", message: "Pool instance placed in maintenance" },
    INSTANCE_DRAINED: { code: "pool.instance_drained", message: "Pool instance drained and removed" },
    INSTANCE_PROVISIONED: { code: "pool.instance_provisioned", message: "New pool instance provisioned" },
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

export const EVENT_METADATA: EventMetadataMap = {
  // Instance events
  [EVENTS.INSTANCE.CREATED.code]: {
    title: "🚀 Instance Created",
    description: (data: any) => `A new instance **${data.instanceId}** has been created.`,
    color: 0x00ff00,
    category: "instance",
  },
  [EVENTS.INSTANCE.MODIFIED.code]: {
    title: "🔧 Instance Modified",
    description: (data: any) => `Instance **${data.instanceId}** has been modified.`,
    color: 0xffa500,
    category: "instance",
  },
  [EVENTS.INSTANCE.DELETED.code]: {
    title: "🗑️ Instance Deleted",
    description: (data: any) => `Instance **${data.instanceId}** has been deleted.`,
    color: 0xff0000,
    category: "instance",
  },
  [EVENTS.CLUSTER.MODIFIED.code]: {
    title: "⚙️ Cluster Modified",
    description: (data: any) => `Cluster **${data.clusterName || data.clusterId}** has been modified.`,
    color: 0xffa500,
    category: "cluster",
  },
  [EVENTS.CLUSTER.INVITE_ACCEPTED.code]: {
    title: "👥 User Joined Cluster",
    description: (data: any) => `**${data.userEmail}** joined the cluster.`,
    color: 0x0099ff,
    category: "cluster",
  },
  [EVENTS.CLUSTER.REMOVED_USER.code]: {
    title: "👋 User Left Cluster",
    description: (data: any) => `**${data.userEmail}** left the cluster.`,
    color: 0xff9900,
    category: "cluster",
  },
  [EVENTS.CLUSTER.USER_ROLE_CHANGED.code]: {
    title: "🔄 User Role Changed",
    description: (data: any) => `**${data.userEmail}**'s role changed from **${data.oldRole}** to **${data.newRole}**.`,
    color: 0x9b59b6,
    category: "user",
  },
  [EVENTS.CLUSTER.OWNERSHIP_TRANSFERRED.code]: {
    title: "👑 Ownership Transferred",
    description: (data: any) => `Cluster ownership transferred from **${data.previousOwner}** to **${data.newOwner}**.`,
    color: 0xffd700,
    category: "user",
  },

  // Auth events
  [EVENTS.AUTH.SESSION_CREATED.code]: {
    title: "🔐 Sign-in Detected",
    description: (data: any) => `**${data.userEmail}** signed in from **${data.ipAddress || "unknown location"}**.`,
    color: 0x3498db,
    category: "auth",
  },
  [EVENTS.CLUSTER.USER_INVITED.code]: {
    title: "✉️ User Invited",
    description: (data: any) => `**${data.userEmail}** was invited to join the cluster.`,
    color: 0x2980b9,
    category: "cluster",
  },
  [EVENTS.CLUSTER.INVITE_REVOKED.code]: {
    title: "🛑 Invite Revoked",
    description: (data: any) => `Invite for **${data.userEmail}** was revoked.`,
    color: 0x7f8c8d,
    category: "cluster",
  },
  [EVENTS.CLUSTER.INVITE_DECLINED.code]: {
    title: "🙅 Invite Declined",
    description: (data: any) => `**${data.userEmail}** declined the cluster invite.`,
    color: 0xe67e22,
    category: "cluster",
  },

  // Billing envents
  [EVENTS.BILLING.PAYMENT_SUCCESSFUL.code]: {
    title: "💳 Payment Successful",
    description: (data: any) => `Your **${data.plan}** subscription payment was processed successfully.`,
    color: 0x00ff00,
    category: "billing",
  },
  [EVENTS.BILLING.PAYMENT_FAILED.code]: {
    title: "💳 Payment Failed",
    description: (data: any) => `Your **${data.plan}** subscription payment failed. Please update your payment method within 7 days to avoid service interruption.`,
    color: 0xff0000,
    category: "billing",
  },
  [EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code]: {
    title: "⚠️ Subscription Canceled",
    description: (data: any) => `Your **${data.plan}** subscription has been canceled. You'll have access until **${new Date(data.periodEnd).toLocaleDateString()}**.`,
    color: 0xffa500,
    category: "billing",
  },
  [EVENTS.BILLING.SUBSCRIPTION_EXPIRED.code]: {
    title: "❌ Subscription Expired",
    description: (data: any) => `Your subscription has expired. You've been moved to the free **hobby** plan.`,
    color: 0xff0000,
    category: "billing",
  },
};

