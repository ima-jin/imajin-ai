import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

let _client: ReturnType<typeof postgres> | null = null;

function getClient() {
  if (!_client) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    _client = postgres(process.env.DATABASE_URL);
  }
  return _client;
}

export function createDb<TSchema extends Record<string, unknown>>(schema: TSchema): PostgresJsDatabase<TSchema> {
  return drizzle(getClient(), { schema });
}

export { getClient };
export type { PostgresJsDatabase };
