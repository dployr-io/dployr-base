import { Hono } from "hono";
import { Bindings, Variables } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { verifyGitHubWebhook } from "@/services/utils";
import { GitHubService } from "@/services/github";
import { getCookie } from "hono/cookie";
import { WORKFLOW_NAME } from "@/lib/constants";

const gitHub = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// List available GitHub repositories 
// This list reposistories that are accessible to the GitHub installation
gitHub.get("/remotes", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  try {
    const gitHub = new GitHubService(c.env);

    // Get query param cluster_id
    // if none is set, list all user clusters
    const clusterIdParam = c.req.query("cluster_id");
    const clusterIds = clusterIdParam
      ? [clusterIdParam]
      : await d1.clusters.listUserClusters(session.user_id);

    // Get clusters where user is owner and collect bootstrap IDs
    const clusterData = await Promise.all(
      clusterIds.map(async (clusterId) => {
        const cluster = await d1.clusters.get(clusterId);
        if (!cluster) return null;

        const isOwner = await d1.clusters.isOwner(session.user_id, clusterId);
        if (!isOwner) return null;

        return {
          clusterId: cluster.id,
          clusterName: cluster.name,
          bootstrapId: cluster.bootstrapId,
        };
      })
    );

    // Filter out nulls and clusters without bootstrap IDs
    const validClusters = clusterData.filter(
      (c) => c !== null && c.bootstrapId !== null
    );

    // Fetch remotes for each bootstrap ID and flatten into a single list
    const remotesArrays = await Promise.all(
      validClusters.map(async (cluster) => {
        if (!cluster || cluster.bootstrapId === null) return [];

        try {
          const remotes = await gitHub.listRemotes(cluster.bootstrapId);
          return remotes.map((remote) => ({
            ...remote,
            clusterId: cluster.clusterId,
          }));
        } catch (error) {
          console.error(`Failed to fetch remotes for cluster ${cluster.clusterId}:`, error);
          return [];
        }
      })
    );

    // Flatten the array of arrays into a single array
    const allRemotes = remotesArrays.flat();

    return c.json({
      success: true,
      remotes: allRemotes,
    });
  } catch (error) {
    console.error("List remotes error:", error);
    return c.json({ error: "Failed to list remotes" }, 500);
  }
});

// Webhook to subscribe to events
gitHub.post("/webhook", async (c) => {
  try {
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");
    const payload = await c.req.text();

    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const isValid = await verifyGitHubWebhook(
      payload,
      signature,
      c.env.GITHUB_WEBHOOK_SECRET
    );

    if (!isValid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const body = JSON.parse(payload);

    // [DEBUG]
    console.debug(`Recieved debug information -> ${payload}`)

    const d1 = new D1Store(c.env.BASE_DB);
    const kv = new KVStore(c.env.BASE_KV);

    // Handle installation events
    if (event === "installation" && body.action === "created") {
      const installation = body.installation;

      // Store installation data
      await d1.bootstraps.create(installation.id);

      console.log(`GitHub App installed: ${installation.id}`);
    }

    // Handle meta events (app deleted)
    if (event === "meta" && body.action === "deleted") {
      const hookId = body.hook_id;
      console.log(`GitHub App hook deleted: ${hookId}`);
      // Cleanup if needed
    }

    // Handle workflow_run events (completed)
    if (event === "workflow_run") {
      const { workflow_run, repository } = body;

      if (workflow_run.name === WORKFLOW_NAME) {
        const status = workflow_run.conclusion; // success, failure, cancelled, etc.
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

        // notification on failure
        if (status === "failure") {
          console.error(`Deployment failed for ${repository.full_name}`);
          // email notification here
        }
      }
    }

    // Handle push events (auto-deploy on code changes)
    if (event === "push") {
      const { repository, ref, pusher, commits } = body;

      console.log(
        `Auto-deploying ${repository.full_name} after push by ${pusher.name}`
      );
    }

    return c.json({ message: "Webhook processed" });
  } catch (error) {
    console.error("Webhook error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default gitHub;
