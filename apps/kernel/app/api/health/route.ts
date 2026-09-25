import { NextResponse } from 'next/server';

// buildPublicUrlAbsolute (not buildPublicUrl) is required here: this runs
// server-side and calls fetch() directly, so it needs a guaranteed absolute
// URL. buildPublicUrl() falls back to a bare relative path (e.g. "/input")
// once neither an explicit NEXT_PUBLIC_{NAME}_URL env var nor an explicit
// prefix/domain is present, which fetch() cannot parse (#2345).
import { buildPublicUrlAbsolute } from '@imajin/config';
// #2384: kernel is also master of its own schema (auth/chat/pay/profile/
// etc. all live in kernel-owned schemas, migrations/OWNERSHIP.md), so it
// reports its own migration state via the same helper every other app
// uses -- never by reading another service's DB directly.
import { createPostgresMigrationsQuerier, getClient, getMigrationStatus, type MigrationStatus } from '@imajin/db';

interface ServiceCheck {
  name: string;
  label: string;
  url: string;
  status: 'up' | 'down' | 'degraded';
  responseTime: number | null;
  statusCode: number | null;
  error?: string;
  /** Relayed verbatim from the service's own /api/health body, when present (#2384). */
  migrations?: MigrationStatus;
}

const SERVICES = [
  // Core platform
  { name: 'www', label: 'Website' },
  { name: 'auth', label: 'Auth' },
  { name: 'pay', label: 'Payments' },
  { name: 'profile', label: 'Profiles' },
  { name: 'registry', label: 'Registry' },
  { name: 'events', label: 'Events' },
  { name: 'chat', label: 'Chat' },
  { name: 'connections', label: 'Connections' },
  { name: 'input', label: 'Input' },
  { name: 'media', label: 'Media' },
  // Imajin apps
  { name: 'coffee', label: 'Coffee' },
  { name: 'dykil', label: 'Surveys' },
  { name: 'links', label: 'Links' },
  { name: 'learn', label: 'Learn' },
  { name: 'market', label: 'Market' },
];

// Reads the `migrations` block off a service's own /api/health body, if
// present. Never throws: a non-JSON body or a response with no `migrations`
// field (e.g. a kernel sub-route like "auth" that isn't its own app) is a
// normal "this service doesn't report migrations" case, not a failure.
async function readMigrationsBlock(response: Response): Promise<MigrationStatus | undefined> {
  try {
    const body = await response.json() as { migrations?: MigrationStatus };
    return body.migrations;
  } catch {
    return undefined;
  }
}

// #2384: this app is master of its own schema; never throws -- a DB/
// connection failure degrades to an error shape so this route always
// renders a response.
async function checkOwnMigrations(): Promise<MigrationStatus> {
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

function hasPendingMigrations(migrations: MigrationStatus | undefined): boolean {
  return migrations != null && migrations.pendingCount !== null && migrations.pendingCount > 0;
}

async function checkService(service: { name: string; label: string }): Promise<ServiceCheck> {
  const url = buildPublicUrlAbsolute(service.name);
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    // GET (not HEAD): the migrations block this route relays (#2384) only
    // exists in the response body, which a HEAD request never returns.
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual', // Don't follow redirects — a redirect means the service is alive
      cache: 'no-store',
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - start;

    // Any response (including redirects, 401, 403) means the service is up.
    // Only 5xx means degraded.
    const status = response.status >= 500 ? 'degraded' : 'up';
    const migrations = await readMigrationsBlock(response);

    return {
      name: service.name,
      label: service.label,
      url,
      status,
      responseTime,
      statusCode: response.status,
      migrations,
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    return {
      name: service.name,
      label: service.label,
      url,
      status: 'down',
      responseTime: responseTime < 10000 ? responseTime : null,
      statusCode: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function GET() {
  const [checks, migrations] = await Promise.all([
    Promise.all(SERVICES.map(checkService)),
    checkOwnMigrations(),
  ]);

  const allUp = checks.every(c => c.status === 'up');
  const anyDown = checks.some(c => c.status === 'down');
  // #2384: degraded if kernel's own schema, or any relayed service's schema, has pending migrations.
  const anyMigrationsPending = hasPendingMigrations(migrations) || checks.some(c => hasPendingMigrations(c.migrations));

  return NextResponse.json({
    status: (() => { if (anyDown || anyMigrationsPending) { return 'degraded'; } if (allUp) { return 'operational'; } return 'degraded'; })(),
    version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
    build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
    timestamp: new Date().toISOString(),
    migrations,
    services: checks,
  });
}
