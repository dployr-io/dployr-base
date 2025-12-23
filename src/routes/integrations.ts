// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { verifyGitHubWebhook } from "@/services/utils.js";
import { ERROR } from "@/lib/constants/index.js";
import { requireClusterDeveloper } from "@/middleware/auth.js";
import { GitHubService } from "@/services/github.js";
import { GitLabService } from "@/services/gitlab.js";
import { BitBucketService } from "@/services/bitbucket.js";
import { IntegrationsService } from "@/services/integrations.js";
import { getKV, getDB, type AppVariables } from "@/lib/context.js";

const integrations = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

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

    const db = new DatabaseStore(getDB(c));
    const kv = new KVStore(getKV(c));
    const integrationsService = new IntegrationsService(c.env, db, kv);

    // Handle installation events
    if (event === "installation" && body.action === "created") {
      await integrationsService.handleGitHubInstallation(body);
    }

    // Handle meta events (app deleted)
    if (event === "meta" && body.action === "deleted") {
      await integrationsService.handleGitHubMeta(body);
    }

    // Handle workflow_run events (completed)
    if (event === "workflow_run") {
      await integrationsService.handleGitHubWorkflowRun(body);
    }

    // Handle push events
    if (event === "push") {
      await integrationsService.handleGitHubPush(body);
    }

    return c.json(createSuccessResponse({}, "Webhook processed"));
  } catch (error) {
    console.error("Webhook error:", error);
    const helpLink = "https://monitoring.dployr.io";
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code, 
      helpLink 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// GitHub install 
integrations.get("/github/install", requireClusterDeveloper, async (c) => {
  const clusterId = c.req.query("clusterId");
  const session = c.get("session")!;
  
  if (!clusterId) {
    return c.json(createErrorResponse({ 
      message: "Missing clusterId query parameter", 
      code: ERROR.REQUEST.BAD_REQUEST.code 
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const kv = new KVStore(getKV(c));
  await kv.setPendingGitHubInstall(session.userId, clusterId);
    
  return c.redirect("https://github.com/apps/dployr-io/installations/new", 302);
});

// GitHub callback
integrations.get("/github/callback", async (c) => {
  const appUrl = c.env.APP_URL;
  
  try {
    const installationId = c.req.query("installation_id");
    const sessionId = getCookie(c, "session");
    const kv = new KVStore(getKV(c));
        
    let clusterId: string | null = null;
    let userId: string | null = null;
    
    if (sessionId) {
      const session = await kv.getSession(sessionId);
      if (session) {
        userId = session.userId;
        clusterId = await kv.getPendingGitHubInstall(userId);
      }
    }
    
    if (!installationId) {
      // No installation_id - user cancelled or error
      if (clusterId) {
        if (userId) await kv.deletePendingGitHubInstall(userId);
        return c.redirect(`${appUrl}/clusters/${clusterId}/settings/integrations?error=cancelled`, 302);
      }
      return c.redirect(`${appUrl}?error=github_cancelled`, 302);
    }

    // Fetch installation details
    const githubService = new GitHubService(c.env);
    const installation = await githubService.getInstallation(parseInt(installationId));
    
    if (!installation) {
      console.error("Failed to fetch GitHub installation:", installationId);
      if (clusterId) {
        if (userId) await kv.deletePendingGitHubInstall(userId);
        return c.redirect(`${appUrl}/clusters/${clusterId}/settings/integrations?error=installation_not_found`, 302);
      }
      return c.redirect(`${appUrl}?error=installation_not_found`, 302);
    }

    if (!clusterId) {
      return c.redirect(`${appUrl}?github_installed=true&installation_id=${installationId}`, 302);
    }
    
    if (userId) await kv.deletePendingGitHubInstall(userId);
    
    const db = new DatabaseStore(getDB(c));
    await db.clusters.installGitHubIntegration(clusterId, {
      loginId: installation.account.login,
      installUrl: installation.htmlUrl,
      installationId: installation.id,
    });
    
    return c.redirect(`${appUrl}/clusters/${clusterId}/settings/integrations?success=github`, 302);
  } catch (error) {
    console.error("GitHub callback error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// GitLab integration setup
integrations.post("/gitlab/setup", requireClusterDeveloper, async (c) => {
  try {
    const { accessToken, enabled } = await c.req.json();
    const clusterId = c.req.query("clusterId");
    
    if (!clusterId) {
      return c.json(createErrorResponse({ 
        message: "Missing clusterId query parameter", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const gitlabService = new GitLabService(c.env);

    await gitlabService.remoteCount({ accessToken });

    const db = new DatabaseStore(getDB(c));
    await db.clusters.update(clusterId, {
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
integrations.post("/bitbucket/setup", requireClusterDeveloper, async (c) => {
  try {
    const { accessToken, enabled } = await c.req.json();
    const clusterId = c.req.query("clusterId");
    
    if (!clusterId) {
      return c.json(createErrorResponse({ 
        message: "Missing clusterId query parameter", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const bitbucketService = new BitBucketService(c.env);

    // Test access
    await bitbucketService.remoteCount({ accessToken });

    const db = new DatabaseStore(getDB(c));
    await db.clusters.update(clusterId, {
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
integrations.get("/list", requireClusterDeveloper, async (c) => {
  try {
    const clusterId = c.req.query("clusterId");
    
    if (!clusterId) {
      return c.json(createErrorResponse({ 
        message: "Missing clusterId query parameter", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const db = new DatabaseStore(getDB(c));
    const integrations = await db.clusters.listClusterIntegrations(clusterId);

    return c.json(createSuccessResponse(integrations, "Integrations retrieved"));
  } catch (error) {
    console.error("List integrations error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// List all remotes from configured integrations
integrations.get("/remotes", requireClusterDeveloper, async (c) => {
  try {
    const clusterId = c.req.query("clusterId");
    
    if (!clusterId) {
      return c.json(createErrorResponse({ 
        message: "Missing clusterId query parameter", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const db = new DatabaseStore(getDB(c));
    const clusterIntegrations = await db.clusters.listClusterIntegrations(clusterId);
    const integrationsService = new IntegrationsService(c.env);
    const remotes = await integrationsService.listAllRemotes(clusterIntegrations);

    return c.json(createSuccessResponse({ remotes }, "Remotes retrieved"));
  } catch (error) {
    console.error("List remotes error:", error);
    return c.json(createErrorResponse({ 
      message: "Internal server error", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default integrations;
