// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { authMiddleware } from "@/middleware/auth";
import { ERROR } from "@/lib/constants";
import { getKV, getDB, type AppVariables } from "@/lib/context";

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();
deployments.use("*", authMiddleware);

// List all deployments
deployments.get("/", async (c) => {
  const kv = new KVStore(getKV(c));
  const d1 = new D1Store(getDB(c) as D1Database);
  const session = c.get("session")!;

  if (!session) {
    return c.json(createErrorResponse({
      message: "Invalid or expired session",
      code: ERROR.AUTH.BAD_SESSION.code
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  const instances = await d1.instances.getByClusters(session.clusters);

  // TODO: Implement deployment listing logic
  return c.json(createSuccessResponse({ deployments: [], instances }));
});

export default deployments;
