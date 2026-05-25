import { EventMetadataMap } from "@/services/notifications/notifier.js";
import { InstanceStatus } from "@/types/index.js";

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
    SUBSCRIPTION_RESUMED: { code: "billing.subscription_resumed", message: "Your subscription has been resumed" },
    SUBSCRIPTION_CANCELLED: { code: "billing.subscription_cancelled", message: "Your subscription has been cancelled" },
    SUBSCRIPTION_EXPIRED: { code: "billing.subscription_expired", message: "Your subscription has expired" },
  },
  INSTANCE: {
    CREATED: { code: "instance.created", message: "Instance created successfully" },
    UPDATED: { code: "instance.updated", message: "Instance updated successfully" },
    DELETED: { code: "instance.deleted", message: "Instance deleted successfully" },
  },
  DOMAIN: {
    VERIFIED: { code: "domain.verified", message: "Domain verified successfully" },
  },
  SERVICE: {
    UNHEALTHY: { code: "service.unhealthy", message: "Service is unhealthy" },
    RECOVERED: { code: "service.recovered", message: "Service has recovered" },
    ICING_WARNING: { code: "service.icing_warning", message: "Service will be iced in 5 days" },
    ICED: { code: "service.iced", message: "Service has been iced due to inactivity" },
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
  NODE: {
    HEALTHY: { code: "node.healthy", message: "Node is healthy" },
    DEGRADED: { code: "node.degraded", message: "Node is degraded" },
    OFFLINE: { code: "node.offline", message: "Node is offline" },
    UNREACHABLE: { code: "node.unreachable", message: "Node is unreachable" },
    MAINTENANCE: { code: "node.maintenance", message: "Node placed under maintenance" },
    DRAINED: { code: "node.drained", message: "Node drained and removed" },
    DATA_CLEARED: { code: "node.data_cleared", message: "Node data cleared" },
    PROVISIONED: { code: "node.provisioned", message: "New instance provisioned" },
    DECOMMISSIONED: { code: "node.decommissioned", message: "Node marked for decommission" },
    ALLOCATED: { code: "node.allocated", message: "Pool instance allocated" },
  },
} as const;

export const DEFAULT_EVENTS = [
  EVENTS.INSTANCE.CREATED.code,
  EVENTS.INSTANCE.UPDATED.code,
  EVENTS.INSTANCE.DELETED.code,
  EVENTS.CLUSTER.INVITE_ACCEPTED.code,
  EVENTS.CLUSTER.USER_INVITED.code,
  EVENTS.CLUSTER.REMOVED_USER.code,
  EVENTS.CLUSTER.USER_ROLE_CHANGED.code,
];

/** Maps an InstanceStatus to the corresponding event code. */
export const HEADLESS_EVENTS: Record<InstanceStatus, string> = {
  healthy: EVENTS.NODE.HEALTHY.code,
  degraded: EVENTS.NODE.DEGRADED.code,
  offline: EVENTS.NODE.OFFLINE.code,
  unreachable: EVENTS.NODE.UNREACHABLE.code,
  maintenance: EVENTS.NODE.MAINTENANCE.code,
  provisioning: EVENTS.NODE.PROVISIONED.code,
};

export const EVENT_METADATA: EventMetadataMap = {
  // Instance events
  [EVENTS.INSTANCE.CREATED.code]: {
    title: "🚀 Instance Created",
    description: (data: any) => `A new instance **${data.instanceId}** has been created.`,
    color: 0x00ff00,
    category: "instance",
  },
  [EVENTS.INSTANCE.UPDATED.code]: {
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
  [EVENTS.BILLING.SUBSCRIPTION_RESUMED.code]: {
    title: "✅ Subscription Resumed",
    description: (data: any) => `Your **${data.plan}** subscription has been resumed and is now active again.`,
    color: 0x00ff00,
    category: "billing",
  },
  [EVENTS.SERVICE.UNHEALTHY.code]: {
    title: "Service Unhealthy",
    description: (data: any) => `Service **${data.serviceName}** is failing its health check.`,
    color: 0xff0000,
    category: "instance",
  },
  [EVENTS.SERVICE.RECOVERED.code]: {
    title: "✅ Service Recovered",
    description: (data: any) => `Service **${data.serviceName}** has recovered and is healthy again.`,
    color: 0x00ff00,
    category: "instance",
  },
  [EVENTS.SERVICE.ICING_WARNING.code]: {
    title: "Service Icing Soon",
    description: (data: any) => `Service **${data.serviceName}** has been inactive for 25 days and will be frozen in 5 days.`,
    color: 0xff9900,
    category: "instance",
  },
  [EVENTS.SERVICE.ICED.code]: {
    title: "Service Frozen",
    description: (data: any) => `Service **${data.serviceName}** has been frozen due to 30 days of inactivity.`,
    color: 0x6b7280,
    category: "instance",
  },
};
