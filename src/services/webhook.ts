import { Notifier, NotificationPayload } from "./notifier";

export class WebhookService implements Notifier {
  async sendNotification({
    webhookUrl,
    event,
    data,
    headers,
    method,
    timeoutMs,
  }: NotificationPayload): Promise<void> {
    if (!webhookUrl) {
      throw new Error("Webhook URL is required");
    }

    const payload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const controller = new AbortController();
    const id = timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      await fetch(webhookUrl, {
        method: method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...(headers || {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      if (id !== undefined) {
        clearTimeout(id);
      }
    }
  }
}
