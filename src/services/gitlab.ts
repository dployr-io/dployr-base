import type { Bindings } from "@/types";

export class GitLabService {
  constructor(private env: Bindings) {}

  async listRemotes({ accessToken }: { accessToken: string }) {
    const response = await fetch("https://gitlab.com/api/v4/projects?membership=true&per_page=100", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.statusText}`);
    }

    const projects = await response.json() as Array<{
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
  }

  async remoteCount({ accessToken }: { accessToken: string }) {
    const remotes = await this.listRemotes({ accessToken });
    return remotes.length;
  }

  async triggerPipeline({
    accessToken,
    projectId,
    ref,
    variables,
  }: {
    accessToken: string;
    projectId: number;
    ref: string;
    variables: Record<string, string>;
  }) {
    const response = await fetch(
      `https://gitlab.com/api/v4/projects/${projectId}/pipeline`,
      {
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
      }
    );

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.statusText}`);
    }

    return { triggered: true };
  }
}
