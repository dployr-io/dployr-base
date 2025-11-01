import { initializeDatabase } from '@/lib/migrate';

export async function initializeApp(env: { BASE_DB: D1Database }): Promise<void> {
    await initializeDatabase(env.BASE_DB);
}