// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings } from "@/types/index.js";
import { GitLabAPIError, GitLabAuthenticationError, GitLabNotFoundError, GitLabPermissionError, GitLabRateLimitError } from "@/lib/errors/errors.js";

export class GitLabService {
  constructor(private env: Bindings) {}

  async listRemotes({ accessToken }: { accessToken: string }) {
    const response = await fetch("https://gitlab.com/api/v4/projects?membership=true&per_page=100", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return this.handleResponse(response, (body) => {
      const projects = body as Array<{
        id: number;
        name: string;
        path_with_namespace: string;
        visibility: string;
        web_url: string;
        namespace: { path: string };
      }>;

      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        fullName: project.path_with_namespace,
        private: project.visibility !== "public",
        htmlUrl: project.web_url,
        owner: project.namespace.path,
      }));
    });
  }

  async remoteCount({ accessToken }: { accessToken: string }) {
    const remotes = await this.listRemotes({ accessToken });
    return remotes.length;
  }

  async triggerPipeline({ accessToken, projectId, ref, variables }: { accessToken: string; projectId: number; ref: string; variables: Record<string, string> }) {
    const response = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref,
        variables: Object.entries(variables).map(([key, value]) => ({
          key,
          value,
        })),
      }),
    });

    return this.handleResponse(response, () => {
      return { triggered: true };
    });
  }

  private async handleResponse<T>(response: Response, parser: (body: any) => T): Promise<T> {
    if (!response.ok) {
      let body: any = null;
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        try {
          body = await response.json();
        } catch {
          // JSON parsing failed, use statusText
        }
      }
      this.parseGitlabError(response, body);
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const data = await response.json();
      return parser(data);
    }

    return parser(null);
  }

  /**
   * Parses a GitLab API response and throws appropriate typed errors.
   * Call this after checking response.ok === false.
   *
   * @param response - The Fetch API Response object
   * @param body - Optional pre-parsed JSON body (if already parsed)
   * @throws GitLabAuthenticationError for 401 responses
   * @throws GitLabPermissionError for 403 responses
   * @throws GitLabNotFoundError for 404 responses
   * @throws GitLabRateLimitError for 429 responses
   * @throws GitLabAPIError for all other error statuses
   */
  private parseGitlabError(response: Response, body: unknown = null): never {
    const status = response.status;
    let message = response.statusText;

    if (body && typeof body === "object" && body !== null) {
      const bodyObj = body as Record<string, any>;
      message = bodyObj.message || bodyObj.error || message;
    }

    switch (status) {
      case 401:
        throw new GitLabAuthenticationError(message);
      case 403:
        throw new GitLabPermissionError(message);
      case 404:
        throw new GitLabNotFoundError(message);
      case 429: {
        const retryAfter = response.headers.get("Retry-After");
        const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : null;
        throw new GitLabRateLimitError(retrySeconds);
      }
      default:
        throw new GitLabAPIError(status, message, body as any);
    }
  }
}
