// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { authMiddleware } from "@/middleware/auth.js";
import { ERROR } from "@/lib/constants/index.js";
import { getKV, getDB, type AppVariables } from "@/lib/context.js";

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();
deployments.use("*", authMiddleware);

// List all deployments
deployments.get("/", async (c) => {
  const db = new DatabaseStore(getDB(c));
  const session = c.get("session")!;

  if (!session) {
    return c.json(createErrorResponse({
      message: "Invalid or expired session",
      code: ERROR.AUTH.BAD_SESSION.code
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  // TODO: Implement proper deployment listing with multiple clusters
  const instances: any[] = [];

  // TODO: Implement deployment listing logic
  return c.json(createSuccessResponse({ deployments: [], instances }));
});

export default deployments;
