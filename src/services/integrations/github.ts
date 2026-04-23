// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { Buffer } from "buffer";
import type { Bindings } from "@/types/index.js";

export class GitHubService {

  private appAuth?: ReturnType<typeof createAppAuth>;

  constructor(private env: Bindings) {
    const appId = env.GITHUB_APP_ID;
    const privateKey = env.GITHUB_APP_PRIVATE_KEY;
    
    if (appId && privateKey) {
      this.appAuth = createAppAuth({
        appId,
        privateKey,
      });
    }
  }

  private async getOctokit(installationId: number): Promise<Octokit> {
    if (!this.appAuth || !installationId) {
      throw new Error("GITHUB_APP_NOT_CONFIGURED");
    }

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

  async listRemotes({ installationId }: { installationId?: number }) {
    // If GitHub App or installation is missing, return an empty list 
    if (!this.appAuth || !installationId) {
      return [];
    }

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

  async remoteCount({ installationId }: { installationId?: number }) {
    if (!this.appAuth || !installationId) {
      return 0;
    }

    const octokit = await this.getOctokit(installationId);

    const repos = await octokit.paginate(
      octokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 }
    );

    return repos.length;
  }

  async getInstallation(installationId: number): Promise<{
    id: number;
    account: { login: string; type: string };
    htmlUrl: string;
  } | null> {
    if (!this.appAuth) {
      throw new Error("GITHUB_APP_NOT_CONFIGURED");
    }

    const auth = await this.appAuth({ type: "app" });
    const octokit = new Octokit({ auth: auth.token });

    try {
      const res = await octokit.apps.getInstallation({ installation_id: installationId });
      return {
        id: res.data.id,
        account: {
          login: (res.data.account as any)?.login || "",
          type: (res.data.account as any)?.type || "User",
        },
        htmlUrl: res.data.html_url,
      };
    } catch (error) {
      console.error("Failed to get GitHub installation:", error);
      return null;
    }
  }

  async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    tokenType: string;
  } | null> {
    const clientId = this.env.GITHUB_CLIENT_ID;
    const clientSecret = this.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("GITHUB_OAUTH_NOT_CONFIGURED");
    }

    try {
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });

      const data = await response.json() as any;

      if (data.error) {
        console.error("GitHub OAuth error:", data.error, data.error_description);
        return null;
      }

      return {
        accessToken: data.access_token,
        tokenType: data.token_type,
      };
    } catch (error) {
      console.error("Failed to exchange GitHub code for token:", error);
      return null;
    }
  }

  async getUserInstallations(accessToken: string): Promise<Array<{
    id: number;
    account: { login: string; type: string };
    htmlUrl: string;
  }>> {
    const octokit = new Octokit({ auth: accessToken });

    try {
      const res = await octokit.apps.listInstallationsForAuthenticatedUser();
      return res.data.installations.map((inst) => ({
        id: inst.id,
        account: {
          login: (inst.account as any)?.login || "",
          type: (inst.account as any)?.type || "User",
        },
        htmlUrl: inst.html_url || `https://github.com/settings/installations/${inst.id}`,
      }));
    } catch (error) {
      console.error("Failed to get user installations:", error);
      return [];
    }
  }
}
