import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

/**
 * Domain-to-IP mapping for traffic routing.
 */
export class DomainStore {
  constructor(private kv: IKVAdapter) {}

  /**
   * Maps a dployr subdomain (the instance `tag`) to its IPv4 address. Used by
   * the traffic router to resolve `{tag}.dployr.io` requests. Stored without
   * a TTL — entries persist until explicitly deleted.
   *
   * @param domain - The subdomain / instance tag (e.g. `"my-node"`).
   * @param address - The IPv4 address the domain resolves to.
   */
  async saveDomain({ domain, address }: { domain: string; address: string }): Promise<void> {
    await this.kv.put(KV_KEYS.DOMAIN(domain), address);
  }

  /**
   * Looks up the IPv4 address for a dployr subdomain.
   *
   * @param domain - The subdomain / instance tag to look up.
   * @returns The IPv4 address string, or `null` if not found.
   */
  async getDomain(domain: string): Promise<string | null> {
    const data = await this.kv.get(KV_KEYS.DOMAIN(domain));
    if (!data) return null;
    return data;
  }
}
