// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

const BASE_URL = process.env.BASE_URL ?? "http://localhost:7878";
const TEST_EMAIL = process.env.TEST_EMAIL ?? "ci-test@example.com";

export interface TestFixtures {
  session: string; // Cookie header value: "session=..."
  clusterId: string;
  cleanup: () => Promise<void>; // at the end
}

interface CreatedResources {
  instanceIds: string[];
  domainNames: string[];
  clusterId: string | null;
  clusterCreated: boolean;
}

async function getSession(): Promise<string> {
  // Step 1: request OTP
  const req = await fetch(`${BASE_URL}/v1/auth/login/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL }),
  });
  if (!req.ok) {
    const body = await req.text();
    throw new Error(`OTP request failed ${req.status}: ${body}`);
  }

  // Step 2: verify OTP and capture session cookie
  const verify = await fetch(`${BASE_URL}/v1/auth/login/email/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, code: "000000" }),
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

/**
 * Gets or creates the CI test cluster.
 * Uses TEST_CLUSTER_ID if set (skips creation).
 * Otherwise creates one named "ci-test-<timestamp>".
 */
async function provisionCluster(authHeader: string, resources: CreatedResources): Promise<string> {
  if (process.env.TEST_CLUSTER_ID) {
    resources.clusterId = process.env.TEST_CLUSTER_ID;
    return process.env.TEST_CLUSTER_ID;
  }

  // Try to find an existing CI cluster first (avoids proliferation on retries)
  const listRes = await apiFetch("/v1/clusters", authHeader);
  const listBody = (await listRes.json()) as any;
  const existing = (listBody.data?.clusters ?? []).find((c: any) => c.name?.startsWith("ci-test"));
  if (existing) {
    resources.clusterId = existing.id;
    return existing.id;
  }

  // Create a new one
  const createRes = await apiFetch("/v1/clusters", authHeader, {
    method: "POST",
    body: JSON.stringify({ name: `ci-test-${Date.now()}` }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Failed to create cluster: ${createRes.status} ${body}`);
  }

  const body = (await createRes.json()) as any;
  const id = body.data?.cluster?.id ?? body.data?.id;
  if (!id) throw new Error(`Cluster created but no ID in response: ${JSON.stringify(body)}`);

  resources.clusterId = id;
  resources.clusterCreated = true;
  console.log(`[fixtures] Created test cluster: ${id}`);
  return id;
}

async function cleanup(authHeader: string, resources: CreatedResources): Promise<void> {
  const errors: string[] = [];

  // Delete instances
  for (const id of resources.instanceIds) {
    try {
      const res = await apiFetch(`/v1/instances/${id}`, authHeader, { method: "DELETE" });
      if (!res.ok) errors.push(`Instance ${id}: ${res.status}`);
      else console.log(`[fixtures] Deleted instance: ${id}`);
    } catch (e) {
      errors.push(`Instance ${id}: ${e}`);
    }
  }

  // Remove custom domains
  for (const domain of resources.domainNames) {
    try {
      const res = await apiFetch(`/v1/domains/${domain}`, authHeader, { method: "DELETE" });
      if (!res.ok && res.status !== 404) errors.push(`Domain ${domain}: ${res.status}`);
      else console.log(`[fixtures] Removed domain: ${domain}`);
    } catch (e) {
      errors.push(`Domain ${domain}: ${e}`);
    }
  }

  if (resources.clusterCreated && resources.clusterId) {
    try {
      const res = await apiFetch(`/v1/clusters/${resources.clusterId}`, authHeader, { method: "DELETE" });
      if (!res.ok) errors.push(`Cluster ${resources.clusterId}: ${res.status}`);
      else console.log(`[fixtures] Deleted cluster: ${resources.clusterId}`);
    } catch (e) {
      errors.push(`Cluster ${resources.clusterId}: ${e}`);
    }
  }

  if (errors.length > 0) {
    console.warn(`[fixtures] Cleanup errors:\n  ${errors.join("\n  ")}`);
  }
}

export async function setupFixtures(): Promise<TestFixtures> {
  const resources: CreatedResources = {
    instanceIds: [],
    domainNames: [],
    clusterId: null,
    clusterCreated: false,
  };

  console.log(`[fixtures] NODE_ENV=${process.env.NODE_ENV} BASE_URL=${BASE_URL}`);

  const sessionCookie = await getSession();
  console.log("[fixtures] Session obtained");

  const clusterId = await provisionCluster(sessionCookie, resources);
  console.log(`[fixtures] Using cluster: ${clusterId}`);

  return {
    session: sessionCookie,
    clusterId,
    cleanup: () => cleanup(sessionCookie, resources),
  };
}

/**
 * Register a resource so it gets cleaned up after the test run.
 * Call this inside tests whenever you create something.
 */
export function trackInstance(fixtures: TestFixtures & { _resources: CreatedResources }, id: string) {
  fixtures._resources.instanceIds.push(id);
}

export function trackDomain(fixtures: TestFixtures & { _resources: CreatedResources }, domain: string) {
  fixtures._resources.domainNames.push(domain);
}

function apiFetch(path: string, authCookie: string, init: RequestInit = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookie,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
