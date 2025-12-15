// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings, Integrations, Remote, RemoteListResult } from "@/types/index.js";
import { GitHubService } from "./github.js";
import { GitLabService } from "./gitlab.js";
import { BitBucketService } from "./bitbucket.js";
import type { DatabaseStore } from "@/lib/db/store/index.js";
import type { KVStore } from "@/lib/db/store/kv.js";
import { WORKFLOW_NAME } from "@/lib/constants/index.js";

export interface RemoteRepository {
  id: string | number;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  owner: string;
  defaultBranch?: string;
  avatarUrl?: string | null;
}

export class IntegrationsService {
  private githubService: GitHubService;
  private gitlabService: GitLabService;
  private bitbucketService: BitBucketService;

  constructor(
    private env: Bindings,
    private db?: DatabaseStore,
    private kv?: KVStore
  ) {
    this.githubService = new GitHubService(env);
    this.gitlabService = new GitLabService(env);
    this.bitbucketService = new BitBucketService(env);
  }

  async listAllRemotes(integrations: Integrations): Promise<RemoteListResult[]> {
    const results: RemoteListResult[] = [];
    const promises: Promise<void>[] = [];

    // GitHub
    if (integrations.remote?.gitHub?.installationId) {
      promises.push(
        this.fetchGitHubRemotes(integrations.remote.gitHub.installationId)
          .then((remotes) => {
            results.push({ provider: "github", remotes });
          })
          .catch((error) => {
            results.push({ provider: "github", remotes: [], error: error.message });
          })
      );
    }

    // GitLab
    if (integrations.remote?.gitLab?.accessToken && integrations.remote.gitLab.enabled) {
      promises.push(
        this.fetchGitLabRemotes(integrations.remote.gitLab.accessToken)
          .then((remotes) => {
            results.push({ provider: "gitlab", remotes });
          })
          .catch((error) => {
            results.push({ provider: "gitlab", remotes: [], error: error.message });
          })
      );
    }

    // BitBucket
    if (integrations.remote?.bitBucket?.accessToken && integrations.remote.bitBucket.enabled) {
      promises.push(
        this.fetchBitBucketRemotes(integrations.remote.bitBucket.accessToken)
          .then((remotes) => {
            results.push({ provider: "bitbucket", remotes });
          })
          .catch((error) => {
            results.push({ provider: "bitbucket", remotes: [], error: error.message });
          })
      );
    }

    await Promise.all(promises);
    return results;
  }

  private async fetchGitHubRemotes(installationId: number): Promise<Remote[]> {
    const repos = await this.githubService.listRemotes({ installationId });
    return repos.map((repo) => this.toRemote(repo, "github"));
  }

  private async fetchGitLabRemotes(accessToken: string): Promise<Remote[]> {
    const repos = await this.gitlabService.listRemotes({ accessToken });
    return repos.map((repo) => this.toRemote(repo, "gitlab"));
  }

  private async fetchBitBucketRemotes(accessToken: string): Promise<Remote[]> {
    const repos = await this.bitbucketService.listRemotes({ accessToken });
    return repos.map((repo) => this.toRemote(repo, "bitbucket"));
  }

  private toRemote(
    repo: RemoteRepository,
    provider: "github" | "gitlab" | "bitbucket"
  ): Remote {
    return {
      url: repo.htmlUrl,
      branch: repo.defaultBranch ?? "main",
      commit_hash: null,
      avatar_url: repo.avatarUrl ?? null,
    };
  }

  // GitHub webhook event handlers
  async handleGitHubInstallation(body: any): Promise<void> {
    const installation = body.installation;
    const account = installation.account;

    if (!installation.id || !account?.login) {
      console.warn(
        `GitHub installation webhook has a bad payload. Missing installation id or account login:`,
        installation
      );
      return;
    }

    // Log the installation event - actual linking happens via OAuth callback
    console.log(
      `GitHub app installation webhook received: ${installation.id} for ${account.login}`
    );
  }

  async handleGitHubMeta(body: any): Promise<void> {
    const hookId = body.hook_id;
    console.log(`GitHub App hook deleted: ${hookId}`);
  }

  async handleGitHubWorkflowRun(body: any): Promise<void> {
    if (!this.kv) {
      throw new Error("KV store not initialized");
    }

    const { workflow_run, repository } = body;

    if (workflow_run.name === WORKFLOW_NAME) {
      const status = workflow_run.conclusion;
      const runId = workflow_run.id;

      console.log(
        `Deployment workflow ${runId} ${status} in ${repository.full_name}`
      );

      await this.kv.createWorkflowFailedEvent(runId, {
        repository: repository.full_name,
        status,
        conclusion: workflow_run.conclusion,
        runId: workflow_run.id,
        htmlUrl: workflow_run.html_url,
        createdAt: workflow_run.created_at,
        updatedAt: workflow_run.updated_at,
      });

      if (status === "failure") {
        console.error(`Deployment failed for ${repository.full_name}`);
      }
    }
  }

  async handleGitHubPush(body: any): Promise<void> {
    const { repository, ref, pusher, commits } = body;

    console.log(
      `Auto-deploying ${repository.full_name} after push by ${pusher.name}`
    );
  }
}
