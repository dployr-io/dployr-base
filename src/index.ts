import { Hono } from "hono";
import { cors } from "hono/cors";
import { Bindings, Variables } from "@/types";
import auth from "@/routes/auth";
import instances from "@/routes/instances";
import gitHub from "@/routes/github";
import { initializeDatabase } from "@/lib/db/migrate";
import clusters from "@/routes/clusters";
import deployments from "@/routes/deployments";
import bootstrap from "@/routes/bootstrap";
import users from "@/routes/users";
import runtime from "@/routes/runtime";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Initialize database on first request
let dbInitialized = false;
app.use("*", async (c, next) => {
  if (!dbInitialized) {
    await initializeDatabase(c.env.BASE_DB);
    dbInitialized = true;
  }
  await next();
});

// CORS
app.use(
  "/v1/*",
  cors({
    origin: (origin) => {
      const allowedOrigins = ["https://app.dployr.dev"];
      return allowedOrigins.includes(origin) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

app.route("/v1/auth", auth);
app.route("/v1/users", users);
app.route("/v1/instances", instances);
app.route("/v1/clusters", clusters);
app.route("/v1/deployments", deployments);
app.route("/v1/bootstrap", bootstrap);
app.route("/v1/github", gitHub);
app.route("/v1/runtime", runtime);
app.get("/v1/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
