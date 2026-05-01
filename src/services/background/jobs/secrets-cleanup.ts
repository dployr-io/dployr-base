// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";

export const secretsCleanup: JobFn = async ({ db }) => {
  if (!db.serviceSecrets) return;
  const deleted = await db.serviceSecrets.cleanup();
  if (deleted > 0) {
    console.log(`[Worker] secrets-cleanup: removed ${deleted} orphaned secret(s)`);
  }
};
