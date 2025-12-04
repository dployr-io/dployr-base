// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { initializeDatabase } from "@/lib/db/migrate.js";

export async function initializeApp(env: {
  BASE_DB: D1Database;
}): Promise<void> {
  await initializeDatabase(env.BASE_DB);
}
