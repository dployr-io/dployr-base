import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types";
import { getCookie } from "hono/cookie";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import z from "zod";
import { generateSecretKey } from "@/services/utils";
import { BOOTSTRAP_TEMPLATE } from "@/lib/constants/bootstrap_template";
import { GitHubService } from "@/services/github";
import { authMiddleware } from "@/middleware/auth";
import { BAD_REQUEST, BOOTSTRAP_RUN_FAILURE, BOOTSTRAP_SETUP_FAILURE } from "@/lib/constants";

const bootstrap = new Hono<{ Bindings: Bindings; Variables: Variables }>();
bootstrap.use("*", authMiddleware);

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
  try {
    const data = await c.req.json();
    const { id, repository } = data;

    const validation = setupRepoSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ message: "Validation failed " + errors, code: BAD_REQUEST }), 400);
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

    return c.json(createSuccessResponse({ repository }, "Bootstrap workflow created successfully"));
  } catch (error) {
    console.error("Setup repository error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ message: "Failed to setup repository", code: BOOTSTRAP_SETUP_FAILURE, helpLink }), 500);
  }
});

// Initiate a workflow
// This initiates a GitHub workflow dipatch to bootstrap the new dployr instance
bootstrap.post("/run", async (c) => {
  try {
    const data = await c.req.json();
    const { id, repository, branch } = data;

    const validation = initiateWorkflowSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ message: "Validation failed " + errors, code: BAD_REQUEST }), 400);
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

    return c.json(createSuccessResponse({ deploymentId }, "Deployment workflow triggered"));
  } catch (error) {
    console.error("Deploy trigger error:", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ message: "Failed to trigger deployment", code: BOOTSTRAP_RUN_FAILURE, helpLink }), 500);
  }
});

export default bootstrap;
