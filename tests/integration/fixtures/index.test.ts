// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import EmbeddedPostgres from "embedded-postgres";
import { RedisMemoryServer } from "redis-memory-server";
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { runMigrations } from "@/lib/db/migrate.js";

const TEST_EMAIL = process.env.TEST_EMAIL ?? "ci-test@example.com";
const OTHER_EMAIL = "ci-test-other@example.com";
const LIMIT_EMAIL = "ci-limit-test@example.com";

// Timeouts for fixture setup operations (in milliseconds)
const TIMEOUT_POSTGRES_STARTUP = 60_000;
const TIMEOUT_MIGRATIONS = 30_000;
const TIMEOUT_REDIS_STARTUP = 20_000;
const TIMEOUT_SERVER_STARTUP = 20_000;
const TIMEOUT_SERVER_HEALTH = 30_000;
const TIMEOUT_SESSION = 10_000;
const TIMEOUT_CLUSTER = 10_000;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface TestFixtures {
  session: string;
  otherSession: string;
  limitSession: string;
  clusterId: string;
  otherClusterId: string;
  limitClusterId: string;
  baseUrl: string;
  setClusterPlan: (clusterId: string, plan: "hobby" | "indie" | "pro") => Promise<void>;
  insertFakeServices: (clusterId: string, count: number) => Promise<void>;
  insertServiceWithName: (clusterId: string, name: string) => Promise<void>;
  insertFakeDomains: (clusterId: string, serviceName: string, count: number) => Promise<void>;
  cleanup: () => Promise<void>;
}

async function startPostgres(): Promise<{ pg: EmbeddedPostgres; connectionString: string }> {
   const databaseDir = join(tmpdir(), `dployr-test-${Date.now()}`);
   const port = await getFreePort();

   const pg = new EmbeddedPostgres({
     databaseDir,
     user: "postgres",
     password: "postgres",
     port,
     persistent: false,
   });

   await pg.initialise();
   await pg.start();

   const connectionString = `postgresql://postgres:postgres@localhost:${port}/postgres?sslmode=disable`;
   return { pg, connectionString };
 }

async function startRedis(): Promise<{ server: RedisMemoryServer; connectionString: string }> {
    const redisServer = new RedisMemoryServer();

    await redisServer.start();
    
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    const connectionString = `redis://${host}:${port}`;
    
    return { server: redisServer, connectionString };
 }

async function spawnServer(connectionString: string, redisConnectionString: string): Promise<{ proc: ChildProcess; port: number }> {
   const port = await getFreePort();
   const proc = spawn("node", ["--import", "tsx", "src/index.ts"], {
     env: {
       ...process.env,
       NODE_ENV: "test",
       DATABASE_URL: connectionString,
       REDIS_URL: redisConnectionString,
       PORT: String(port),
       ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "a".repeat(64),
     },
     stdio: ["ignore", "pipe", "pipe"],
     cwd: process.cwd(),
   });

   proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
   proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));

   return { proc, port };
 }

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms: ${label}`)), timeoutMs)
    ),
  ]);
}

async function waitForHealth(baseUrl: string, maxWaitMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${baseUrl} did not become healthy within ${maxWaitMs}ms`);
}

async function getSession(baseUrl: string, email = TEST_EMAIL): Promise<string> {
  const req = await fetch(`${baseUrl}/v1/auth/login/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!req.ok) {
    const body = await req.text();
    throw new Error(`OTP request failed ${req.status}: ${body}`);
  }

  const verify = await fetch(`${baseUrl}/v1/auth/login/email/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code: "000000" }),
  });
  if (!verify.ok) {
    const body = await verify.text();
    throw new Error(`OTP verify failed ${verify.status}: ${body}`);
  }

  const setCookie = verify.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/session=([^;]+)/);
  if (!match) throw new Error("No session cookie in verify response");

  return `session=${match[1]}`;
}

async function resolveCluster(baseUrl: string, authCookie: string): Promise<string> {
  // The cluster is auto-created during OTP verify — just fetch it.
  const res = await apiFetch(baseUrl, "/v1/clusters", authCookie);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to list clusters: ${res.status} ${body}`);
  }

  const body = (await res.json()) as any;
  const clusters: any[] = body.data?.clusters ?? [];
  if (clusters.length === 0) throw new Error("No clusters found after login — expected auto-provisioned cluster");

  return clusters[0].id as string;
}

export async function setupFixtures(): Promise<TestFixtures> {
  const externalDb = process.env.DATABASE_URL;
  const externalRedis = process.env.REDIS_URL;

  let pg: EmbeddedPostgres | null = null;
  let redisServer: RedisMemoryServer | null = null;
  let connectionString: string;
  let redisConnectionString: string;

  if (externalDb) {
    console.log("[fixtures] Using external PostgreSQL:", externalDb);
    connectionString = externalDb;
  } else {
    console.log("[fixtures] Starting embedded PostgreSQL...");
    const result = await withTimeout(startPostgres(), TIMEOUT_POSTGRES_STARTUP, "PostgreSQL startup");
    pg = result.pg;
    connectionString = result.connectionString;
  }

  console.log("[fixtures] Running migrations...");
  const db = new PostgresAdapter(connectionString);
  await withTimeout(runMigrations(db), TIMEOUT_MIGRATIONS, "Database migrations");
  await db.close();

  if (externalRedis) {
    console.log("[fixtures] Using external Redis:", externalRedis);
    redisConnectionString = externalRedis;
  } else {
    console.log("[fixtures] Starting embedded Redis...");
    const result = await withTimeout(startRedis(), TIMEOUT_REDIS_STARTUP, "Redis startup");
    redisServer = result.server;
    redisConnectionString = result.connectionString;
  }

  console.log("[fixtures] Spawning server...");
  const { proc, port } = await withTimeout(
    spawnServer(connectionString, redisConnectionString),
    TIMEOUT_SERVER_STARTUP,
    "Server startup"
  );
  const baseUrl = `http://localhost:${port}`;

  console.log("[fixtures] Waiting for server to be healthy...");
  await withTimeout(waitForHealth(baseUrl), TIMEOUT_SERVER_HEALTH, "Server health check");
  console.log("[fixtures] Server ready");

  const sessionCookie = await withTimeout(getSession(baseUrl), TIMEOUT_SESSION, "Session creation");
  console.log("[fixtures] Session obtained");

  const clusterId = await withTimeout(resolveCluster(baseUrl, sessionCookie), TIMEOUT_CLUSTER, "Cluster resolution");
  console.log(`[fixtures] Using cluster: ${clusterId}`);

  const otherSessionCookie = await withTimeout(getSession(baseUrl, OTHER_EMAIL), TIMEOUT_SESSION, "Other session creation");
  const otherClusterId = await withTimeout(
    resolveCluster(baseUrl, otherSessionCookie),
    TIMEOUT_CLUSTER,
    "Other cluster resolution"
  );
  console.log(`[fixtures] Other cluster: ${otherClusterId}`);

  const limitSessionCookie = await withTimeout(getSession(baseUrl, LIMIT_EMAIL), TIMEOUT_SESSION, "Limit session creation");
  const limitClusterId = await withTimeout(
    resolveCluster(baseUrl, limitSessionCookie),
    TIMEOUT_CLUSTER,
    "Limit cluster resolution"
  );
  console.log(`[fixtures] Limit cluster: ${limitClusterId}`);

  // Upgrade the primary and secondary clusters to pro so service-limit checks don't interfere
  // between test suites that each deploy their own services within the same run.
  // The limit cluster intentionally stays on hobby — it's used by service-limits tests.
  const adminDb = new PostgresAdapter(connectionString);
  const now = Date.now();
  for (const cid of [clusterId, otherClusterId]) {
    await adminDb.prepare(
      `INSERT INTO billing (cluster_id, plan, status, created_at, updated_at)
       VALUES ($1, 'pro', 'active', $2, $2)
       ON CONFLICT (cluster_id) DO UPDATE SET plan = 'pro', status = 'active', updated_at = $2`
    ).bind(cid, now).run();
  }
  await adminDb.close();

  const setClusterPlan = async (cid: string, plan: "hobby" | "indie" | "pro") => {
    const db = new PostgresAdapter(connectionString);
    const ts = Date.now();
    await db.prepare(
      `INSERT INTO billing (cluster_id, plan, status, created_at, updated_at)
       VALUES ($1, $2, 'active', $3, $3)
       ON CONFLICT (cluster_id) DO UPDATE SET plan = $2, status = 'active', updated_at = $3`
    ).bind(cid, plan, ts).run();
    await db.close();
  };

  const insertFakeServices = async (cid: string, count: number) => {
    const db = new PostgresAdapter(connectionString);
    const ts = Date.now();
    for (let i = 0; i < count; i++) {
      const id = `cifake${ts.toString(36)}${i}`;
      const name = `ci-fake-${ts.toString(36)}-${i}`;
      await db.prepare(
        `INSERT INTO services (id, cluster_id, name, type, created_at, updated_at) VALUES ($1, $2, $3, 'web', $4, $4)`
      ).bind(id, cid, name, ts).run();
    }
    await db.close();
  };

  const insertServiceWithName = async (cid: string, name: string) => {
    const db = new PostgresAdapter(connectionString);
    const ts = Date.now();
    const id = `cisvc${ts.toString(36)}`;
    await db.prepare(
      `INSERT INTO services (id, cluster_id, name, type, created_at, updated_at) VALUES ($1, $2, $3, 'web', $4, $4)`
    ).bind(id, cid, name, ts).run();
    await db.close();
  };

  const insertFakeDomains = async (cid: string, serviceName: string, count: number) => {
    const db = new PostgresAdapter(connectionString);
    const ts = Date.now();
    for (let i = 0; i < count; i++) {
      const id = `cidom${ts.toString(36)}${i}`;
      const domain = `ci-fake-${ts.toString(36)}-${i}.example.com`;
      await db.prepare(
        `INSERT INTO domains (id, cluster_id, domain, verification_token, provider, service_name, created_at)
         VALUES ($1, $2, $3, $4, 'unknown', $5, $6)`
      ).bind(id, cid, domain, `tok-${id}`, serviceName, ts).run();
    }
    await db.close();
  };

  return {
    session: sessionCookie,
    otherSession: otherSessionCookie,
    limitSession: limitSessionCookie,
    clusterId,
    otherClusterId,
    limitClusterId,
    baseUrl,
    setClusterPlan,
    insertFakeServices,
    insertServiceWithName,
    insertFakeDomains,
    cleanup: async () => {
      console.log("[fixtures] Killing server...");
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(resolve, 5000);
      });

      if (pg) {
        console.log("[fixtures] Stopping embedded PostgreSQL...");
        await pg.stop();
      }
      if (redisServer) {
        console.log("[fixtures] Stopping embedded Redis...");
        await redisServer.stop();
      }
    },
  };
}

function apiFetch(baseUrl: string, path: string, authCookie: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookie,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}
