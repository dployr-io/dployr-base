import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { Buffer } from "buffer";
import type { Bindings } from "@/types";

export class GitHubService {
  private appAuth: ReturnType<typeof createAppAuth>;

  constructor(private env: Bindings) {
    this.appAuth = createAppAuth({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
    });
  }

  private async getOctokit(installationId: number): Promise<Octokit> {
    const auth = await this.appAuth({
      type: "installation",
      installationId,
    });
    return new Octokit({ auth: auth.token });
  }

  async createFile({
    installationId,
    owner,
    repo,
    path,
    content,
    message,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
  }) {
    const octokit = await this.getOctokit(installationId);
    const encoded = Buffer.from(content).toString("base64");

    try {
      await octokit.repos.getContent({ owner, repo, path });
      return { created: false, message: "File already exists" };
    } catch {
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: encoded,
      });
      return { created: true, message: "File created successfully" };
    }
  }

  async triggerWorkflow({
    installationId,
    owner,
    repo,
    workflow,
    ref,
    inputs,
  }: {
    installationId: number;
    owner: string;
    repo: string;
    workflow: string;
    ref: string;
    inputs: Record<string, string>;
  }) {
    const octokit = await this.getOctokit(installationId);

    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflow,
      ref,
      inputs,
    });

    return { triggered: true };
  }

    async listRemotes({ installationId }: { installationId: number }) {
    const octokit = await this.getOctokit(installationId);

    const res = await octokit.apps.listReposAccessibleToInstallation();

    return res.data.repositories.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      htmlUrl: repo.html_url,
      owner: repo.owner.login,
    }));
  }

  async remoteCount({ installationId }: { installationId: number }) {
    const octokit = await this.getOctokit(installationId);

    const repos = await octokit.paginate(
      octokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 }
    );

    return repos.length;
  }
}
