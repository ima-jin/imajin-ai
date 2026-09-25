import { NextResponse } from 'next/server';

// buildPublicUrlAbsolute (not buildPublicUrl) is required here: this runs
// server-side and calls fetch() directly, so it needs a guaranteed absolute
// URL. buildPublicUrl() falls back to a bare relative path (e.g. "/input")
// once neither an explicit NEXT_PUBLIC_{NAME}_URL env var nor an explicit
// prefix/domain is present, which fetch() cannot parse (#2345).
import { buildPublicUrlAbsolute } from '@imajin/config';
// #2384: kernel is also master of its own schema (auth/chat/pay/profile/
// etc. all live in kernel-owned schemas, migrations/OWNERSHIP.md), so it
// reports its own migration state via the same shared helpers every other
// app's own /api/health route uses (packages/db/src/health-route.ts) --
// never by reading another service's DB directly. Kernel doesn't use
// createAppHealthHandler itself since its own route also aggregates other
// services, but shares the pieces that do.
import { checkAppMigrations, hasPendingMigrations, type MigrationStatus } from '@imajin/db';

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
    checkAppMigrations(),
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
