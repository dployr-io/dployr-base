// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { initializeDatabase } from "@/lib/db/migrate.js";
import type { PostgresAdapter } from "./pg-adapter.js";

export async function initializeApp(env: {
  BASE_DB: PostgresAdapter;
}): Promise<void> {
  await initializeDatabase(env.BASE_DB);
}
