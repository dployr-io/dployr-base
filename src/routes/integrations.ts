// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { verifyGitHubWebhook } from "@/services/utils";
import { ERROR, WORKFLOW_NAME } from "@/lib/constants";
import { requireClusterDeveloper } from "@/middleware/auth";
import { GitLabService } from "@/services/gitlab";
import { BitBucketService } from "@/services/bitbucket";
import { getKV, getDB, type AppVariables } from "@/lib/context";

const integrations = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

integrations.use("*", requireClusterDeveloper);

// GitHub webhook 
integrations.post("/github/webhook", async (c) => {
  try {
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");
    const payload = await c.req.text();
    const body = JSON.parse(payload);

    if (!signature) {
      return c.json(createErrorResponse({ 
        message: "Missing signature", 
        code: ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.code 
      }), ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.status);
    }

    const isValid = await verifyGitHubWebhook({
      payload,
      signature,
      secret: c.env.GITHUB_WEBHOOK_SECRET
    });

    if (!isValid) {
      return c.json(createErrorResponse({ 
        message: "Invalid signature", 
        code: ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.code 
      }), ERROR.RUNTIME.BAD_WEBHOOK_SIGNATURE.status);
    }

    const d1 = new D1Store(getDB(c) as D1Database);
    const kv = new KVStore(getKV(c));

    // Handle installation events
    if (event === "installation" && body.action === "created") {
      const installation = body.installation;
      const account = installation.account;

      if (!installation.id || !account?.login) {
        console.warn(`GitHub installation webhook has a bad payload. Missing installation id or account login:`, installation);
      } else {
        await d1.clusters.installGitHubIntegration({
          loginId: account.login,
          installUrl: installation.html_url || `https://github.com/settings/installations/${installation.id}`,
          installationId: installation.id,
        });

        console.log(`GitHub app installed: ${installation.id} for ${account.login}`);
      }
    }

    // Handle meta events (app deleted)
    if (event === "meta" && body.action === "deleted") {
      const hookId = body.hook_id;
      console.log(`GitHub App hook deleted: ${hookId}`);
    }

    // Handle workflow_run events (completed)
    if (event === "workflow_run") {
      const { workflow_run, repository } = body;

      if (workflow_run.name === WORKFLOW_NAME) {
        const status = workflow_run.conclusion;
        const runId = workflow_run.id;

        console.log(
          `Deployment workflow ${runId} ${status} in ${repository.full_name}`
        );

        await kv.createWorkflowFailedEvent(runId, {
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

    // Handle push events
    if (event === "push") {
      const { repository, ref, pusher, commits } = body;

      console.log(
        `Auto-deploying ${repository.full_name} after push by ${pusher.name}`
      );
    }

    return c.json(createSuccessResponse({}, "Webhook processed"));
  } catch (error) {
    console.error("Webhook error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code, 
      helpLink 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// GitLab integration setup
integrations.post("/gitlab/setup", async (c) => {
  try {
    const { accessToken, enabled } = await c.req.json();
    const session = c.get("session");
    
    if (!session?.clusters?.[0]?.id) {
      return c.json(createErrorResponse({ 
        message: "No cluster found", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const gitlabService = new GitLabService(c.env);
   
    // Test access
    await gitlabService.remoteCount({ accessToken });

    const d1 = new D1Store(c.env.BASE_DB);
    await d1.clusters.update(session.clusters[0].id, {
      metadata: { gitLab: { accessToken, enabled } }
    });

    return c.json(createSuccessResponse({ enabled }, "GitLab integration configured"));
  } catch (error) {
    console.error("GitLab setup error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// BitBucket integration setup
integrations.post("/bitbucket/setup", async (c) => {
  try {
    const { accessToken, enabled } = await c.req.json();
    const session = c.get("session");
    
    if (!session?.clusters?.[0]?.id) {
      return c.json(createErrorResponse({ 
        message: "No cluster found", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const bitbucketService = new BitBucketService(c.env);

    // Test access
    await bitbucketService.remoteCount({ accessToken });

    const d1 = new D1Store(c.env.BASE_DB);
    await d1.clusters.update(session.clusters[0].id, {
      metadata: { bitBucket: { accessToken, enabled } }
    });

    return c.json(createSuccessResponse({ enabled }, "BitBucket integration configured"));
  } catch (error) {
    console.error("BitBucket setup error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// List all integrations for a cluster
integrations.get("/list", async (c) => {
  try {
    const session = c.get("session");
    
    if (!session?.clusters?.[0]?.id) {
      return c.json(createErrorResponse({ 
        message: "No cluster found", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const d1 = new D1Store(c.env.BASE_DB);
    const integrations = await d1.clusters.listClusterIntegrations(session.clusters[0].id);

    return c.json(createSuccessResponse(integrations, "Integrations retrieved"));
  } catch (error) {
    console.error("List integrations error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default integrations;
