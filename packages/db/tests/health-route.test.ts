import { describe, it, expect, vi, beforeEach } from 'vitest';

// health-route.ts imports getClient from './client' and
// getMigrationStatus/createPostgresMigrationsQuerier from
// './migration-status' -- both relative, so they're mocked here by the
// same relative paths (matching migration-status.test.ts's convention of
// importing '../src/*' directly rather than through the '@imajin/db'
// package alias).
const { getMigrationStatusMock } = vi.hoisted(() => ({ getMigrationStatusMock: vi.fn() }));

vi.mock('../src/client', () => ({ getClient: vi.fn(() => ({})) }));
vi.mock('../src/migration-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/migration-status')>();
  return { ...actual, getMigrationStatus: getMigrationStatusMock };
});

const { checkAppMigrations, createAppHealthHandler, hasPendingMigrations } = await import('../src/health-route');
type MigrationStatus = Awaited<ReturnType<typeof checkAppMigrations>>;

const CAUGHT_UP: MigrationStatus = { migrationHead: '0042_fixture.sql', appliedCount: 42, pendingCount: 0 };
const PENDING: MigrationStatus = { migrationHead: '0040_fixture.sql', appliedCount: 40, pendingCount: 2 };

beforeEach(() => {
  getMigrationStatusMock.mockReset().mockResolvedValue(CAUGHT_UP);
});

describe('checkAppMigrations', () => {
  it("returns the underlying querier's status when the DB check succeeds", async () => {
    const status = await checkAppMigrations();

    expect(status).toEqual(CAUGHT_UP);
  });

  it('degrades to a well-formed error shape (never throws) when the DB check fails', async () => {
    getMigrationStatusMock.mockRejectedValue(new Error('connection refused'));

    const status = await checkAppMigrations();

    expect(status).toEqual({
      migrationHead: null,
      appliedCount: 0,
      pendingCount: null,
      error: 'connection refused',
    });
  });
});

describe('hasPendingMigrations', () => {
  it.each<[MigrationStatus | undefined, boolean]>([
    [undefined, false],
    [{ migrationHead: null, appliedCount: 0, pendingCount: null }, false],
    [{ migrationHead: '0001_x.sql', appliedCount: 1, pendingCount: 0 }, false],
    [PENDING, true],
  ])('returns %j -> %s', (migrations, expected) => {
    expect(hasPendingMigrations(migrations)).toBe(expected);
  });
});

describe('createAppHealthHandler', () => {
  it('reports the given service name, an "ok" status, and the migrations block verbatim when caught up', async () => {
    const GET = createAppHealthHandler({ service: 'coffee' });
    const res = await GET();
    const body = await res.json() as { status: string; service: string; migrations: MigrationStatus };

    expect(body.service).toBe('coffee');
    expect(body.status).toBe('ok');
    expect(body.migrations).toEqual(CAUGHT_UP);
  });

  it('reports "degraded" when the migration check reports a positive pendingCount', async () => {
    getMigrationStatusMock.mockResolvedValue(PENDING);

    const GET = createAppHealthHandler({ service: 'learn' });
    const res = await GET();
    const body = await res.json() as { status: string; migrations: MigrationStatus };

    expect(body.status).toBe('degraded');
    expect(body.migrations).toEqual(PENDING);
  });

  it('still renders a well-formed (null) migrationHead instead of throwing when the DB check fails', async () => {
    getMigrationStatusMock.mockRejectedValue(new Error('boom'));

    const GET = createAppHealthHandler({ service: 'market' });
    const res = await GET();
    const body = await res.json() as { status: string; migrations: MigrationStatus };

    expect(body.migrations.migrationHead).toBeNull();
    expect(body.migrations.pendingCount).toBeNull();
    expect(body.migrations.error).toBe('boom');
    // pendingCount unknown (null), not a known positive count -- never
    // forced into "degraded" on an unknown state.
    expect(body.status).toBe('ok');
  });

  it('stamps version/build from env and includes an ISO timestamp', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', '1.2.3');
    vi.stubEnv('NEXT_PUBLIC_BUILD_HASH', 'abc1234');

    const GET = createAppHealthHandler({ service: 'events' });
    const res = await GET();
    const body = await res.json() as { version: string; build: string; timestamp: string };

    expect(body.version).toBe('1.2.3');
    expect(body.build).toBe('abc1234');
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();

    vi.unstubAllEnvs();
  });
});
