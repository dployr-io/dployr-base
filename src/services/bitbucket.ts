// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings } from "@/types";

export class BitBucketService {
  constructor(private env: Bindings) {}

  async listRemotes({ accessToken }: { accessToken: string }) {
    const response = await fetch("https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`BitBucket API error: ${response.statusText}`);
    }

    const data = await response.json() as {
      values: Array<{
        uuid: string;
        name: string;
        full_name: string;
        is_private: boolean;
        links: { html: { href: string } };
        owner: { username: string };
      }>;
    };

    return data.values.map((repo) => ({
      id: repo.uuid,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.is_private,
      htmlUrl: repo.links.html.href,
      owner: repo.owner.username,
    }));
  }

  async remoteCount({ accessToken }: { accessToken: string }) {
    const remotes = await this.listRemotes({ accessToken });
    return remotes.length;
  }

  async triggerPipeline({
    accessToken,
    workspace,
    repoSlug,
    variables,
  }: {
    accessToken: string;
    workspace: string;
    repoSlug: string;
    variables: Record<string, string>;
  }) {
    const response = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/pipelines/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: {
            ref_type: "branch",
            ref_name: "main",
            type: "pipeline_ref_target",
          },
          variables: Object.entries(variables).map(([key, value]) => ({
            key,
            value,
          })),
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`BitBucket API error: ${response.statusText}`);
    }

    return { triggered: true };
  }
}
