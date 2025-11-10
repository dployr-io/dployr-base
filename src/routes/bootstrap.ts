import { Hono } from "hono";
import { Bindings, Variables } from "@/types";
import { getCookie } from "hono/cookie";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import z from "zod";
import { generateSecretKey } from "@/services/utils";
import { BOOTSTRAP_TEMPLATE } from "@/lib/constants/bootstrap_template";
import { GitHubService } from "@/services/github";

const bootstrap = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const setupRepoSchema = z.object({
  id: z.number(),
  repository: z.string().min(10, "repository is required"),
});

const initiateWorkflowSchema = z.object({
  id: z.number(),
  repository: z.string().min(10, "repository is required"),
  branch: z.string().min(10, "branch is required"),
});

// Bootstrap a new instance
// This creates a temporary workflow on the user's repository
// that will be used for provisioning a new dployr instance
bootstrap.post("/", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  try {
    const data = await c.req.json();
    const { id, repository } = data;

    const validation = setupRepoSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const [owner, repo] = repository.split("/");
    const gitHub = new GitHubService(c.env);
    // Check if workflow exists
    await gitHub.createFile(
      parseInt(id),
      owner,
      repo,
      ".github/workflows/dployr-bootstrap.yml",
      BOOTSTRAP_TEMPLATE,
      "Add dployr bootstrap workflow"
    );
  } catch (error) {
    console.error("Setup repository error:", error);
    return c.json({ error: "Failed to setup repository" }, 500);
  }
});

// Initiate a workflow
// This initiates a GitHub workflow dipatch to bootstrap the new dployr instance
bootstrap.post("/run", async (c) => {
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
    const data = await c.req.json();
    const { id, repository, branch } = data;

    const validation = initiateWorkflowSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const bootstrapToken = generateSecretKey();
    const deploymentId = crypto.randomUUID();

    const [owner, repo] = repository.split("/");

    const gitHub = new GitHubService(c.env);

    gitHub.triggerWorkflow(
      id,
      owner,
      repo,
      "dployr-bootstrap.yml",
      branch,
      {
        id: deploymentId,
        token: bootstrapToken,
        config: JSON.stringify({}),
      }
    );

    return c.json({
      success: true,
      deploymentId,
      message: "Deployment workflow triggered",
    });
  } catch (error) {
    console.error("Deploy trigger error:", error);
    return c.json({ error: "Failed to trigger deployment" }, 500);
  }
});

export default bootstrap;
