import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { BILLING_NOTIFICATION_TTL } from "@/lib/constants/index.js";

/**
 * Billing notification dedup sentinel.
 */
export class BillingStore {
  constructor(private kv: IKVAdapter) {}

  /**
   * Returns the billing notification sentinel for a cluster, or `null` if no
   * notification has been sent within the dedup window (24 hours).
   * Used to prevent repeatedly emailing users about the same billing event.
   *
   * @param clusterId - The cluster to check.
   * @returns `"1"` if a notification was recently sent, or `null`.
   */
  async getbillingNotification({ clusterId }: { clusterId: string }): Promise<String | null> {
    return await this.kv.get(KV_KEYS.BILLING_NOTIFICATION(clusterId));
  }

  /**
   * Sets a dedup sentinel indicating a billing notification was just sent for
   * a cluster. Expires after `BILLING_NOTIFICATION_TTL` (24 hours), after which
   * the cluster is eligible to receive another notification.
   *
   * @param clusterId - The cluster that was notified.
   */
  async setReminderNotification({ clusterId }: { clusterId: string }): Promise<void> {
    await this.kv.put(KV_KEYS.BILLING_NOTIFICATION(clusterId), "1", {
      ttl: BILLING_NOTIFICATION_TTL,
    });
  }
}
