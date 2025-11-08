import { Hono } from "hono";
import { cors } from "hono/cors";
import { Bindings, Variables } from "@/types";
import auth from "@/routes/auth";
import instances from "@/routes/instances";
import { initializeDatabase } from "@/lib/db/migrate";
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
  "/api/*",
  cors({
    origin: (origin) => {
      const allowedOrigins = ["https://app.dployr.dev"];
      return allowedOrigins.includes(origin) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

app.route("/api/auth", auth);
app.route("/api/instances", instances);
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
