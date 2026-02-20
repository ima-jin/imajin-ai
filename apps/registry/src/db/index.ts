import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

// Lazy initialization to avoid build-time errors
let _db: PostgresJsDatabase<typeof schema> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_, prop) {
    if (!_db) {
      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL environment variable is not set');
      }
      _client = postgres(process.env.DATABASE_URL);
      _db = drizzle(_client, { schema });
    }
    return (_db as any)[prop];
  },
});

// Re-export schema
export * from './schema';
