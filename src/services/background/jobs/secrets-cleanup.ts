// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("SecretsCleanup");

export const secretsCleanup: JobFn = async ({ db }) => {
  if (!db.serviceSecrets) return;
  const deleted = await db.serviceSecrets.cleanup();
  if (deleted > 0) {
    log.info(`Removed ${deleted} orphaned secret(s)`);
  }
};
