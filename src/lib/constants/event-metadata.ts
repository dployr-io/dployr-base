// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { EVENTS, EventMetadataMap } from "@/services/notifier.js";

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
