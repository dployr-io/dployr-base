import { initializeDatabase } from "@/lib/db/migrate";

export async function initializeApp(env: {
  BASE_DB: D1Database;
}): Promise<void> {
  await initializeDatabase(env.BASE_DB);
}
