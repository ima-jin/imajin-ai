import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { boundSql, timeoutSetting } from './bounds';

let _client: ReturnType<typeof postgres> | null = null;

function getClient() {
  if (!_client) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    const env = process.env;
    _client = boundSql(postgres(env.DATABASE_URL!, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      connection: {
        statement_timeout: timeoutSetting(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000),
        idle_in_transaction_session_timeout: timeoutSetting(env, 'DB_IDLE_TRANSACTION_TIMEOUT_MS', 60_000),
      },
    }), {
      acquireMs: timeoutSetting(env, 'DB_ACQUIRE_TIMEOUT_MS', 10_000),
      queryMs: timeoutSetting(env, 'DB_QUERY_TIMEOUT_MS', 40_000),
    });
  }
  return _client;
}

export function createDb<TSchema extends Record<string, unknown>>(schema: TSchema): PostgresJsDatabase<TSchema> {
  return drizzle(getClient(), { schema });
}

export { getClient };
export type { PostgresJsDatabase };

/**
 * Database handle for consumers that receive an app `db` with many schemas
 * registered. Drizzle's schema generic is invariant, so narrow parameters like
 * `PostgresJsDatabase<typeof someSchema>` reject the full app db when another
 * table is registered.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDatabase = PostgresJsDatabase<any>;
