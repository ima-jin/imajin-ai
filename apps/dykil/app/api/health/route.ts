import { NextResponse } from 'next/server';
import { createPostgresMigrationsQuerier, getClient, getMigrationStatus, type MigrationStatus } from '@imajin/db';

// #2384: this app is master of its own schema, so its own DB connection
// (never another service's) is the only source for its migration state.
// Never throws -- a DB/connection failure degrades to an error shape so
// this route always renders a response.
async function checkMigrations(): Promise<MigrationStatus> {
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

export async function GET() {
  const migrations = await checkMigrations();

  return NextResponse.json({
    status: migrations.pendingCount !== null && migrations.pendingCount > 0 ? 'degraded' : 'ok',
    service: 'dykil',
    version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
    build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
    timestamp: new Date().toISOString(),
    migrations,
  });
}
