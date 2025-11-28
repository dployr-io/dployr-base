import { EVENT_METADATA } from "@/services/event-metadata";

export const notificationTemplate = (event: string, data: Record<string, any>) => {
  const metadata = EVENT_METADATA[event as keyof typeof EVENT_METADATA];
  const title = metadata?.title || "Cluster Notification";
  const message = metadata?.description(data) || "An event occurred in your cluster.";
  const timestamp = new Date().toISOString();

  const detailItems = [];
  if (data.instanceId) {
    detailItems.push(`<p><strong>Instance ID:</strong> ${data.instanceId}</p>`);
  }
  if (data.clusterId) {
    detailItems.push(`<p><strong>Cluster ID:</strong> ${data.clusterId}</p>`);
  }
  if (data.clusterName) {
    detailItems.push(`<p><strong>Cluster Name:</strong> ${data.clusterName}</p>`);
  }
  if (data.userEmail) {
    detailItems.push(`<p><strong>User:</strong> ${data.userEmail}</p>`);
  }
  if (data.role) {
    detailItems.push(`<p><strong>Role:</strong> ${data.role}</p>`);
  }
  if (data.oldRole && data.newRole) {
    detailItems.push(`<p><strong>Role Change:</strong> ${data.oldRole} → ${data.newRole}</p>`);
  }
  if (data.ipAddress) {
    detailItems.push(`<p><strong>IP Address:</strong> ${data.ipAddress}</p>`);
  }
  detailItems.push(`<p><strong>Time:</strong> ${timestamp}</p>`);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body>
  <h2>${title}</h2>
  
  <p>${message.replace(/\*\*/g, "")}</p>

  <hr />

  <h3>Details</h3>
  ${detailItems.join("\n  ")}

  <hr />

  <p>
    <a href="https://app.dployr.dev">View Dashboard</a>
  </p>

  <p>
    <a href="https://dployr.dev">dployr.dev</a><br>
    <i>Your app, your server, your rules!</i>
  </p>

  <p><small>This email is from an unattended mailbox and cannot receive replies.</small></p>
</body>
</html>
`;
};
