/**
 * Shared `/api/health` pieces for every schema-owning app (#2384). Both the
 * migration self-check (`checkAppMigrations`) and the Next.js route handler
 * factory (`createAppHealthHandler`) live here so coffee, dykil, links,
 * learn, market, and events' health routes can't drift out of sync with
 * each other, and are covered by one shared test suite instead of six
 * near-identical ones. Kernel's own `/api/health` also aggregates other
 * services, so it composes `checkAppMigrations`/`hasPendingMigrations`
 * directly rather than using `createAppHealthHandler`.
 */
import { NextResponse } from 'next/server';
import { getClient } from './client';
import { createPostgresMigrationsQuerier, getMigrationStatus, type MigrationStatus } from './migration-status';

/**
 * Computes this app's own migration status. Never throws — a DB/connection
 * failure (e.g. `getClient()` throwing when `DATABASE_URL` is unset)
 * degrades to an error shape so a health route can always render a JSON
 * response instead of a 500.
 */
export async function checkAppMigrations(): Promise<MigrationStatus> {
  try {
    return await getMigrationStatus(createPostgresMigrationsQuerier(getClient()));
  } catch (error) {
    return {
      migrationHead: null,
      appliedCount: 0,
      pendingCount: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/** True only when `migrations` reports a known (non-null), positive pending count. */
export function hasPendingMigrations(migrations: MigrationStatus | undefined): boolean {
  return migrations != null && migrations.pendingCount !== null && migrations.pendingCount > 0;
}

export interface AppHealthHandlerOptions {
  /** This app's own service name, included verbatim in the JSON body. */
  service: string;
}

/**
 * Builds the `GET` handler for a schema-owning app's own `/api/health`
 * route. Every app that owns Postgres tables and isn't also an aggregator
 * (coffee, dykil, links, learn, market, events — see
 * `migrations/OWNERSHIP.md`) uses this directly:
 *
 * ```ts
 * import { createAppHealthHandler } from '@imajin/db';
 * export const GET = createAppHealthHandler({ service: 'coffee' });
 * ```
 */
export function createAppHealthHandler({ service }: AppHealthHandlerOptions) {
  return async function GET() {
    const migrations = await checkAppMigrations();

    return NextResponse.json({
      status: hasPendingMigrations(migrations) ? 'degraded' : 'ok',
      service,
      version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
      build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
      timestamp: new Date().toISOString(),
      migrations,
    });
  };
}
