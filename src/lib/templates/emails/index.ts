// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

const layout = (title: string, content: string): string => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <tr>
          <td style="background:#0f0f0f;padding:20px 32px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">dployr</span>
          </td>
        </tr>

        <tr>
          <td style="padding:32px;color:#111111;font-size:15px;line-height:1.6;">
            ${content}
          </td>
        </tr>

        <tr>
          <td style="border-top:1px solid #eaeaea;padding:20px 32px;color:#6b7280;font-size:13px;line-height:1.5;">
            <a href="https://dployr.io" style="color:#6b7280;text-decoration:none;">dployr.io</a> — Your app, your server, your rules!<br>
            <span style="color:#9ca3af;">This email is from an unattended mailbox and cannot receive replies.</span>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

const btn = (label: string, url: string, variant: "primary" | "danger" = "primary"): string => {
  const bg = variant === "danger" ? "#dc2626" : "#0f0f0f";
  return `<a href="${url}" style="display:inline-block;padding:11px 22px;background:${bg};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;margin:20px 0 8px;">${label}</a>`;
};

const detail = (label: string, value: string): string =>
  `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">${label}</td><td style="padding:6px 0;font-size:13px;">${value}</td></tr>`;

const detailTable = (rows: string[]): string =>
  `<table cellpadding="0" cellspacing="0" style="margin:20px 0;width:100%;">${rows.join("")}</table>`;


export type EmailTemplate<T> = (data: T) => { subject: string; html: string };

export const otpEmail: EmailTemplate<{ name: string; code: string }> = ({ name, code }) => ({
  subject: "Your dployr login code",
  html: layout(
    "Your login code",
    `<p>Hi <strong>${name}</strong>,</p>
    <p>Here is your login code for dployr:</p>
    <div style="margin:24px 0;text-align:center;">
      <span style="display:inline-block;padding:16px 32px;background:#f4f5f7;border-radius:8px;font-size:32px;font-weight:700;letter-spacing:8px;color:#0f0f0f;">${code}</span>
    </div>
    <p style="color:#6b7280;font-size:14px;">This code expires in <strong>10 minutes</strong>. If you didn't request this, you can safely ignore this email.</p>`,
  ),
});

export const inviteEmail: EmailTemplate<{ clusterName: string; clusterId: string }> = ({ clusterName, clusterId }) => ({
  subject: `You've been invited to join ${clusterName} on dployr`,
  html: layout(
    "Cluster Invitation",
    `<p>You've been invited to join the <strong>${clusterName}</strong> cluster on dployr.</p>
    <p>Click below to accept and get started.</p>
    ${btn("Accept Invitation", `https://app.dployr.io/clusters/${clusterId}/invites/accept`)}
    <p style="color:#6b7280;font-size:13px;margin-top:16px;">If you weren't expecting this invite, you can safely ignore this email.</p>`,
  ),
});


export const memberJoinedEmail: EmailTemplate<{ memberEmail: string; clusterName: string; clusterId: string }> = ({
  memberEmail,
  clusterName,
  clusterId,
}) => ({
  subject: `${memberEmail} joined ${clusterName}`,
  html: layout(
    "New Member",
    `<p><strong>${memberEmail}</strong> has accepted your invitation and joined the <strong>${clusterName}</strong> cluster.</p>
    ${btn("View Members", `https://app.dployr.io/clusters/${clusterId}/settings/members`)}`,
  ),
});

export const sessionAlertEmail: EmailTemplate<{ userEmail: string; clusterName: string; clusterId: string; ipAddress?: string }> = ({
  userEmail,
  clusterName,
  clusterId,
  ipAddress,
}) => ({
  subject: `New sign-in detected — ${clusterName}`,
  html: layout(
    "Sign-in Detected",
    `<p>A new sign-in was detected for your cluster <strong>${clusterName}</strong>.</p>
    ${detailTable([
      detail("User", userEmail),
      detail("Cluster", clusterName),
      detail("IP Address", ipAddress ?? "Unknown"),
      detail("Time", new Date().toUTCString()),
    ])}
    <p style="color:#6b7280;font-size:13px;">If this wasn't you, review your cluster access immediately.</p>
    ${btn("Review Access", `https://app.dployr.io/clusters/${clusterId}/settings/members`)}`,
  ),
});

export const instanceCreatedEmail: EmailTemplate<{ instanceId: string; clusterName: string; clusterId: string }> = ({
  instanceId,
  clusterName,
  clusterId,
}) => ({
  subject: `Instance created — ${clusterName}`,
  html: layout(
    "Instance Created",
    `<p>A new instance has been created in the <strong>${clusterName}</strong> cluster.</p>
    ${detailTable([detail("Instance", instanceId), detail("Cluster", clusterName)])}
    ${btn("View Instance", `https://app.dployr.io/clusters/${clusterId}/instances/${instanceId}`)}`,
  ),
});

export const instanceUpdatedEmail: EmailTemplate<{ instanceId: string; clusterName: string; clusterId: string }> = ({
  instanceId,
  clusterName,
  clusterId,
}) => ({
  subject: `Instance updated — ${clusterName}`,
  html: layout(
    "Instance Updated",
    `<p>Instance <strong>${instanceId}</strong> in <strong>${clusterName}</strong> has been updated.</p>
    ${btn("View Instance", `https://app.dployr.io/clusters/${clusterId}/instances/${instanceId}`)}`,
  ),
});

export const instanceDeletedEmail: EmailTemplate<{ instanceId: string; clusterName: string; clusterId: string }> = ({
  instanceId,
  clusterName,
  clusterId,
}) => ({
  subject: `Instance deleted — ${clusterName}`,
  html: layout(
    "Instance Deleted",
    `<p>Instance <strong>${instanceId}</strong> has been deleted from the <strong>${clusterName}</strong> cluster.</p>
    ${btn("View Cluster", `https://app.dployr.io/clusters/${clusterId}`)}`,
  ),
});

export const userRemovedEmail: EmailTemplate<{ memberEmail: string; clusterName: string; clusterId: string }> = ({
  memberEmail,
  clusterName,
  clusterId,
}) => ({
  subject: `User removed from ${clusterName}`,
  html: layout(
    "User Removed",
    `<p><strong>${memberEmail}</strong> has been removed from the <strong>${clusterName}</strong> cluster.</p>
    ${btn("View Members", `https://app.dployr.io/clusters/${clusterId}/settings/members`)}`,
  ),
});

export const roleChangedEmail: EmailTemplate<{ memberEmail: string; oldRole: string; newRole: string; clusterName: string; clusterId: string }> = ({
  memberEmail,
  oldRole,
  newRole,
  clusterName,
  clusterId,
}) => ({
  subject: `User role updated — ${clusterName}`,
  html: layout(
    "Role Changed",
    `<p><strong>${memberEmail}</strong>'s role in <strong>${clusterName}</strong> has been updated.</p>
    ${detailTable([detail("Previous role", oldRole), detail("New role", newRole)])}
    ${btn("View Members", `https://app.dployr.io/clusters/${clusterId}/settings/members`)}`,
  ),
});

export const paymentSuccessEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string }> = ({
  plan,
  clusterName,
  clusterId,
}) => ({
  subject: `Payment successful — ${clusterName}`,
  html: layout(
    "Payment Successful",
    `<p>Your <strong>${plan}</strong> plan payment for <strong>${clusterName}</strong> has been processed successfully.</p>
    ${btn("View Billing", `https://app.dployr.io/clusters/${clusterId}/settings/billing`)}`,
  ),
});

export const paymentFailedEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string }> = ({
  plan,
  clusterName,
  clusterId,
}) => ({
  subject: `Action required: Payment failed — ${clusterName}`,
  html: layout(
    "Payment Failed",
    `<p>Your <strong>${plan}</strong> plan payment for <strong>${clusterName}</strong> has failed.</p>
    <p>Please update your payment method within <strong>7 days</strong> to avoid service interruption.</p>
    ${btn("Update Payment Method", `https://app.dployr.io/clusters/${clusterId}/settings/billing`, "danger")}`,
  ),
});

export const subscriptionCancelledEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string; periodEnd: number | null }> = ({
  plan,
  clusterName,
  clusterId,
  periodEnd,
}) => {
  const accessUntil = periodEnd ? new Date(periodEnd).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : null;

  return {
    subject: `Subscription cancelled — ${clusterName}`,
    html: layout(
      "Subscription Cancelled",
      `<p>Your <strong>${plan}</strong> subscription for <strong>${clusterName}</strong> has been cancelled.</p>
      ${accessUntil ? `<p>You'll continue to have access until <strong>${accessUntil}</strong>.</p>` : ""}
      ${btn("View Billing", `https://app.dployr.io/clusters/${clusterId}/settings/billing`)}`,
    ),
  };
};

export const subscriptionExpiredEmail: EmailTemplate<{ clusterName: string; clusterId: string }> = ({ clusterName, clusterId }) => ({
  subject: `Subscription expired — ${clusterName}`,
  html: layout(
    "Subscription Expired",
    `<p>Your subscription for <strong>${clusterName}</strong> has expired and you've been moved to the <strong>hobby</strong> plan.</p>
    ${btn("Upgrade Plan", `https://app.dployr.io/clusters/${clusterId}/settings/billing`)}`,
  ),
});

export const subscriptionResumedEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string }> = ({
  plan,
  clusterName,
  clusterId,
}) => ({
  subject: `Subscription resumed — ${clusterName}`,
  html: layout(
    "Subscription Resumed",
    `<p>Your <strong>${plan}</strong> subscription for <strong>${clusterName}</strong> has been resumed. Everything is back to normal!</p>
    ${btn("View Dashboard", `https://app.dployr.io/clusters/${clusterId}`)}`,
  ),
});
