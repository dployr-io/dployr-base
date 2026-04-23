import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv-keys.js";
import {
  PENDING_GITHUB_INSTALL_TTL,
  RELEASE_CACHE_TTL,
} from "@/lib/constants/index.js";

/**
 * Third-party integrations: GitHub app install state and version cache.
 */
export class IntegrationsStore {
  constructor(private kv: IKVAdapter, private githubToken?: string) {}

  /**
   * Temporarily stores the `clusterId` a user was trying to link when they
   * initiated a GitHub App installation. Consumed by the OAuth callback to
   * complete the installation flow. Expires after `PENDING_GITHUB_INSTALL_TTL`
   * (10 minutes).
   *
   * @param userId - The user who initiated the installation.
   * @param clusterId - The cluster they were linking the GitHub App to.
   */
  async setPendingGitHubInstall(userId: string, clusterId: string): Promise<void> {
    await this.kv.put(KV_KEYS.PENDING_GITHUB_INSTALL(userId), clusterId, {
      ttl: PENDING_GITHUB_INSTALL_TTL,
    });
  }

  /**
   * Returns the pending cluster ID for a GitHub App installation, or `null`
   * if no pending installation exists for the user.
   *
   * @param userId - The user whose pending installation to retrieve.
   * @returns The cluster ID string, or `null`.
   */
  async getPendingGitHubInstall(userId: string): Promise<string | null> {
    return this.kv.get(KV_KEYS.PENDING_GITHUB_INSTALL(userId));
  }

  /**
   * Deletes the pending GitHub installation record for a user. Called after
   * the installation is successfully completed or abandoned.
   *
   * @param userId - The user whose pending installation to remove.
   */
  async deletePendingGitHubInstall(userId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.PENDING_GITHUB_INSTALL(userId));
  }


  // Retrieves the latest dployrd version from cache
  async getLatestVersion(): Promise<string | null> {
    const cached = await this.getCachedLatestVersion();
    if (cached) return cached;
    return this.fetchAndCacheLatestVersion();
  }

  /**
   * Returns the cached latest dployrd release tag without hitting the GitHub
   * API. Returns `null` if the cache is empty or the stored value is malformed.
   *
   * @returns A semver tag string (e.g. `"v0.5.1"`), or `null`.
   */
  private async getCachedLatestVersion(): Promise<string | null> {
    try {
      const raw = await this.kv.get(KV_KEYS.VERSION_LATEST);
      if (!raw) return null;
      const data = JSON.parse(raw) as { tag?: string } | null;
      if (data && typeof data.tag === "string" && data.tag.length > 0) {
        return data.tag;
      }
    } catch {}
    return null;
  }

  /**
   * Fetches the latest dployrd release tag from the GitHub API and caches it
   * for `RELEASE_CACHE_TTL` (10 minutes). Uses the configured GitHub token if
   * available to avoid rate limits. Returns `null` on any network or parse error.
   *
   * @returns A semver tag string (e.g. `"v0.5.1"`), or `null`.
   */
  private async fetchAndCacheLatestVersion(): Promise<string | null> {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "dployr-base",
      };
      const token = (this.githubToken || "").trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const resp = await fetch("https://api.github.com/repos/dployr-io/dployr/releases/latest", { headers });
      if (!resp.ok) {
        return null;
      }
      const body = await resp.json();
      const tag = (body as any).tag_name as string | undefined;
      if (!tag) return null;

      await this.kv.put(KV_KEYS.VERSION_LATEST, JSON.stringify({ tag }), {
        ttl: RELEASE_CACHE_TTL,
      });

      return tag;
    } catch {
      return null;
    }
  }
}
