// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { EVENTS, EventMetadataMap } from "./notifier";

export const EVENT_METADATA: EventMetadataMap = {
  // Instance events
  [EVENTS.INSTANCE.CREATED.code]: {
    title: "🚀 Instance Created",
    description: (data) => `A new instance **${data.instanceId}** has been created.`,
    color: 0x00ff00,
    category: "instance",
  },
  [EVENTS.INSTANCE.MODIFIED.code]: {
    title: "🔧 Instance Modified",
    description: (data) => `Instance **${data.instanceId}** has been modified.`,
    color: 0xffa500,
    category: "instance",
  },
  [EVENTS.INSTANCE.DELETED.code]: {
    title: "🗑️ Instance Deleted",
    description: (data) => `Instance **${data.instanceId}** has been deleted.`,
    color: 0xff0000,
    category: "instance",
  },
  [EVENTS.CLUSTER.MODIFIED.code]: {
    title: "⚙️ Cluster Modified",
    description: (data) => `Cluster **${data.clusterName || data.clusterId}** has been modified.`,
    color: 0xffa500,
    category: "cluster",
  },
  [EVENTS.CLUSTER.INVITE_ACCEPTED.code]: {
    title: "👥 User Joined Cluster",
    description: (data) => `**${data.userEmail}** joined the cluster.`,
    color: 0x0099ff,
    category: "cluster",
  },
  [EVENTS.CLUSTER.REMOVED_USER.code]: {
    title: "👋 User Left Cluster",
    description: (data) => `**${data.userEmail}** left the cluster.`,
    color: 0xff9900,
    category: "cluster",
  },
  [EVENTS.CLUSTER.USER_ROLE_CHANGED.code]: {
    title: "🔄 User Role Changed",
    description: (data) => `**${data.userEmail}**'s role changed from **${data.oldRole}** to **${data.newRole}**.`,
    color: 0x9b59b6,
    category: "user",
  },
  [EVENTS.CLUSTER.OWNERSHIP_TRANSFERRED.code]: {
    title: "👑 Ownership Transferred",
    description: (data) => `Cluster ownership transferred from **${data.previousOwner}** to **${data.newOwner}**.`,
    color: 0xffd700,
    category: "user",
  },

  // Auth events
  [EVENTS.AUTH.SESSION_CREATED.code]: {
    title: "🔐 Sign-in Detected",
    description: (data) => `**${data.userEmail}** signed in from **${data.ipAddress || "unknown location"}**.`,
    color: 0x3498db,
    category: "auth",
  },
  [EVENTS.CLUSTER.USER_INVITED.code]: {
    title: "✉️ User Invited",
    description: (data) => `**${data.userEmail}** was invited to join the cluster.`,
    color: 0x2980b9,
    category: "cluster",
  },
  [EVENTS.CLUSTER.INVITE_REVOKED.code]: {
    title: "🛑 Invite Revoked",
    description: (data) => `Invite for **${data.userEmail}** was revoked.`,
    color: 0x7f8c8d,
    category: "cluster",
  },
  [EVENTS.CLUSTER.INVITE_DECLINED.code]: {
    title: "🙅 Invite Declined",
    description: (data) => `**${data.userEmail}** declined the cluster invite.`,
    color: 0xe67e22,
    category: "cluster",
  },
};
