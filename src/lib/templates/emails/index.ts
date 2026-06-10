// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

const layout = (title: string, content: string): string => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;600;700&display=swap');</style>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,0.10);">

        <tr>
          <td style="background:#0f0f0f;padding:15px 32px;">
            <a href="https://dployr.io" style="text-decoration:none;display:inline-block;line-height:1;">
              <img src="https://dployr.io/wordmark-light.png" alt="dployr" width="140" height="28" style="display:block;border:0;width:140px;height:28px;" />
            </a>
          </td>
        </tr>

        <tr>
          <td style="padding:36px 32px 32px;color:#111111;font-size:15px;line-height:1.65;">
            ${content}
          </td>
        </tr>

        <tr>
          <td style="background:#0f0f0f;padding:28px 32px 24px;text-align:center;">
            <p style="margin:0 0 4px 0;color:#f9fafb;font-size:13px;font-weight:600;letter-spacing:-0.1px;">Ship apps, not infrastructure.</p>
            <p style="margin:0 0 20px 0;color:#4b5563;font-size:11px;line-height:1.6;">This email is from an unattended mailbox and cannot receive replies.</p>
            <p style="margin:0 0 16px 0;font-size:12px;line-height:1.5;">
              <a href="https://dployr.io/docs/introduction" style="color:#9ca3af;text-decoration:none;">Docs</a>
              <span style="color:#2d3748;margin:0 8px;">&middot;</span>
              <a href="https://status.dployr.io/" style="color:#9ca3af;text-decoration:none;">Status</a>
              <span style="color:#2d3748;margin:0 8px;">&middot;</span>
              <a href="https://discord.gg/tY8ZbjvrSZ" style="color:#9ca3af;text-decoration:none;">Discord</a>
              <span style="color:#2d3748;margin:0 8px;">&middot;</span>
              <a href="https://x.com/dployr" style="color:#9ca3af;text-decoration:none;">X</a>
              <span style="color:#2d3748;margin:0 8px;">&middot;</span>
              <a href="mailto:support@dployr.io" style="color:#9ca3af;text-decoration:none;">Support</a>
              <span style="color:#2d3748;margin:0 8px;">&middot;</span>
              <a href="https://dployr.io/legal/privacy-policy" style="color:#9ca3af;text-decoration:none;">Privacy</a>
              <span style="color:#2d3748;margin:0 8px;">&middot;</span>
              <a href="https://dployr.io/legal/terms-of-service" style="color:#9ca3af;text-decoration:none;">Terms</a>
            </p>
            <p style="margin:0;color:#374151;font-size:11px;">Copyright &copy; 2026 dployr</p>
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

const detailTable = (rows: string[]): string => `<table cellpadding="0" cellspacing="0" style="margin:20px 0;width:100%;">${rows.join("")}</table>`;

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

export const memberJoinedEmail: EmailTemplate<{ memberEmail: string; clusterName: string; clusterId: string }> = ({ memberEmail, clusterName, clusterId }) => ({
  subject: `${memberEmail} joined ${clusterName}`,
  html: layout(
    "New Member",
    `<p><strong>${memberEmail}</strong> has accepted your invitation and joined the <strong>${clusterName}</strong> cluster.</p>
    ${btn("View Members", `https://app.dployr.io/clusters/${clusterId}/settings/members`)}`,
  ),
});

export const sessionAlertEmail: EmailTemplate<{ userEmail: string; clusterName: string; clusterId: string; ipAddress?: string }> = ({ userEmail, clusterName, clusterId, ipAddress }) => ({
  subject: `New sign-in detected — ${clusterName}`,
  html: layout(
    "Sign-in Detected",
    `<p>A new sign-in was detected for your cluster <strong>${clusterName}</strong>.</p>
    ${detailTable([detail("User", userEmail), detail("Cluster", clusterName), detail("IP Address", ipAddress ?? "Unknown"), detail("Time", new Date().toUTCString())])}
    <p style="color:#6b7280;font-size:13px;">If this wasn't you, review your cluster access immediately.</p>
    ${btn("Review Access", `https://app.dployr.io/clusters/${clusterId}/settings/members`)}`,
  ),
});

export const instanceCreatedEmail: EmailTemplate<{ instanceId: string; clusterName: string; clusterId: string }> = ({ instanceId, clusterName, clusterId }) => ({
  subject: `Instance created — ${clusterName}`,
  html: layout(
    "Instance Created",
    `<p>A new instance has been created in the <strong>${clusterName}</strong> cluster.</p>
    ${detailTable([detail("Instance", instanceId), detail("Cluster", clusterName)])}
    ${btn("View Instance", `https://app.dployr.io/clusters/${clusterId}/instances/${instanceId}`)}`,
  ),
});

export const instanceUpdatedEmail: EmailTemplate<{ instanceId: string; clusterName: string; clusterId: string }> = ({ instanceId, clusterName, clusterId }) => ({
  subject: `Instance updated — ${clusterName}`,
  html: layout(
    "Instance Updated",
    `<p>Instance <strong>${instanceId}</strong> in <strong>${clusterName}</strong> has been updated.</p>
    ${btn("View Instance", `https://app.dployr.io/clusters/${clusterId}/instances/${instanceId}`)}`,
  ),
});

export const instanceDeletedEmail: EmailTemplate<{ instanceId: string; clusterName: string; clusterId: string }> = ({ instanceId, clusterName, clusterId }) => ({
  subject: `Instance deleted — ${clusterName}`,
  html: layout(
    "Instance Deleted",
    `<p>Instance <strong>${instanceId}</strong> has been deleted from the <strong>${clusterName}</strong> cluster.</p>
    ${btn("View Cluster", `https://app.dployr.io/clusters/${clusterId}`)}`,
  ),
});

export const userRemovedEmail: EmailTemplate<{ memberEmail: string; clusterName: string; clusterId: string }> = ({ memberEmail, clusterName, clusterId }) => ({
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

export const serviceUnhealthyEmail: EmailTemplate<{ serviceName: string; clusterName: string; clusterId: string }> = ({ serviceName, clusterName, clusterId }) => ({
  subject: `Service down — ${serviceName}`,
  html: layout(
    "Service Unhealthy",
    `<p>Your service <strong>${serviceName}</strong> in <strong>${clusterName}</strong> is failing its health check.</p>
    <p>The container is running but not responding as expected. This usually means the application crashed or is stuck.</p>
    ${btn("View Service", `https://app.dployr.io/clusters/${clusterId}/services/${serviceName}`)}
    <p style="color:#6b7280;font-size:13px;margin-top:16px;">If the service recovers on its own, you won't receive another email until it goes down again.</p>`,
  ),
});

export const serviceIcingWarningEmail: EmailTemplate<{ serviceName: string; clusterName: string; clusterId: string }> = ({ serviceName, clusterName, clusterId }) => ({
  subject: `Your app will be frozen in 5 days — ${serviceName}`,
  html: layout(
    "App Freezing Soon",
    `<p>Your app <strong>${serviceName}</strong> in <strong>${clusterName}</strong> hasn't received any real visitors in 25 days.</p>
    <p>If it stays inactive, it will be <strong>frozen in 5 days</strong>. A frozen app stops running and its image is removed to free up resources. You can reactivate it with one click at any time by redeploying.</p>
    <p style="color:#6b7280;font-size:13px;">This only applies to the hobby plan. Upgrade to keep your app running 24/7.</p>
    ${btn("View App", `https://app.dployr.io/clusters/${clusterId}/services/${serviceName}`)}`,
  ),
});

export const serviceIcedEmail: EmailTemplate<{ serviceName: string; clusterName: string; clusterId: string }> = ({ serviceName, clusterName, clusterId }) => ({
  subject: `Your app has been frozen — ${serviceName}`,
  html: layout(
    "App Frozen",
    `<p>Your app <strong>${serviceName}</strong> in <strong>${clusterName}</strong> has been frozen after 30 days with no real visitors.</p>
    <p>The app is no longer running. To bring it back, redeploy with one click at anytime from your dashboard.</p>
    ${btn("Reactivate App", `https://app.dployr.io/clusters/${clusterId}/services/${serviceName}`)}
    <p style="color:#6b7280;font-size:13px;">Your configuration and environment variables are saved. Upgrade to a paid plan to prevent this from happening again.</p>`,
  ),
});

export const serviceRecoveredEmail: EmailTemplate<{ serviceName: string; clusterName: string; clusterId: string }> = ({ serviceName, clusterName, clusterId }) => ({
  subject: `Service recovered — ${serviceName}`,
  html: layout(
    "Service Recovered",
    `<p>Your service <strong>${serviceName}</strong> in <strong>${clusterName}</strong> has recovered and is ready to serve traffic.</p>
    ${btn("View Service", `https://app.dployr.io/clusters/${clusterId}/services/${serviceName}`)}`,
  ),
});

export const ownershipTransferredEmail: EmailTemplate<{ newOwner: string; previousOwner: string; clusterName: string; clusterId: string }> = ({ newOwner, previousOwner, clusterName, clusterId }) => ({
  subject: `Cluster ownership transferred — ${clusterName}`,
  html: layout(
    "Ownership Transferred",
    `<p>Ownership of the <strong>${clusterName}</strong> cluster has been transferred.</p>
    ${detailTable([detail("Previous owner", previousOwner), detail("New owner", newOwner)])}
    ${btn("View Cluster", `https://app.dployr.io/clusters/${clusterId}/settings/members`)}`,
  ),
});

export const paymentSuccessEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string }> = ({ plan, clusterName, clusterId }) => ({
  subject: `Payment successful — ${clusterName}`,
  html: layout(
    "Payment Successful",
    `<p>Your <strong>${plan}</strong> plan payment for <strong>${clusterName}</strong> has been processed successfully.</p>
    ${btn("View Billing", `https://app.dployr.io/clusters/${clusterId}/settings/billing`)}`,
  ),
});

export const paymentFailedEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string }> = ({ plan, clusterName, clusterId }) => ({
  subject: `Action required: Payment failed — ${clusterName}`,
  html: layout(
    "Payment Failed",
    `<p>Your <strong>${plan}</strong> plan payment for <strong>${clusterName}</strong> has failed.</p>
    <p>Please update your payment method within <strong>7 days</strong> to avoid service interruption.</p>
    ${btn("Update Payment Method", `https://app.dployr.io/clusters/${clusterId}/settings/billing`)}`,
  ),
});

export const subscriptionCancelledEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string; periodEnd: number | null }> = ({ plan, clusterName, clusterId, periodEnd }) => {
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

export const subscriptionResumedEmail: EmailTemplate<{ plan: string; clusterName: string; clusterId: string }> = ({ plan, clusterName, clusterId }) => ({
  subject: `Subscription resumed — ${clusterName}`,
  html: layout(
    "Subscription Resumed",
    `<p>Your <strong>${plan}</strong> subscription for <strong>${clusterName}</strong> has been resumed. Everything is back to normal!</p>
    ${btn("View Dashboard", `https://app.dployr.io/clusters/${clusterId}`)}`,
  ),
});

export const apiTokenKeyRevokedEmail: EmailTemplate<{ keyVersion: string; clusterName: string; clusterId: string; tokenCount: number }> = ({
  keyVersion,
  clusterName,
  clusterId,
  tokenCount,
}) => ({
  subject: `Security alert: API tokens revoked — ${clusterName}`,
  html: layout(
    "API Tokens Revoked",
    `<p>A dployr administrator has revoked API token key version <strong>${keyVersion}</strong>.</p>
    ${detailTable([
      detail("Cluster", clusterName),
      detail("Key version", keyVersion),
      detail("Tokens affected", String(tokenCount)),
      detail("Time", new Date().toUTCString()),
    ])}
    <p>Any CI/CD pipelines or scripts using a <code style="background:#f4f5f7;padding:2px 6px;border-radius:4px;font-size:13px;">dpat_</code> token created under this key version are now <strong>invalid</strong>. You'll need to generate a new token and update your environments.</p>
    ${btn("Regenerate Tokens", `https://app.dployr.io/clusters/${clusterId}/settings/tokens`, "danger")}
    <p style="color:#6b7280;font-size:13px;margin-top:16px;">If you're unsure why this happened, contact your dployr administrator. This action is typically taken in response to a security incident.</p>`,
  ),
});
