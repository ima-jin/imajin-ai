import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { boundSql, timeoutSetting } from './bounds';

const CLIENT = Symbol.for('imajin.db.client');
const shared = globalThis as typeof globalThis & { [CLIENT]?: ReturnType<typeof postgres> };

function getClient() {
  if (!shared[CLIENT]) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    const env = process.env;
    const acquireMs = timeoutSetting(env, 'DB_ACQUIRE_TIMEOUT_MS', 10_000);
    const queryMs = timeoutSetting(env, 'DB_QUERY_TIMEOUT_MS', 40_000);
    const connection = {
      statement_timeout: timeoutSetting(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000),
      idle_in_transaction_session_timeout: timeoutSetting(env, 'DB_IDLE_TRANSACTION_TIMEOUT_MS', 60_000),
    };
    const client = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      connection,
    });
    // postgres.js gives URL startup parameters precedence over connection.
    // Explicit runtime policy must win even when an old URL contains zero.
    Object.assign(client.options.connection, connection);
    shared[CLIENT] = boundSql(client, {
      acquireMs,
      queryMs,
    });
  }
  return shared[CLIENT];
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
