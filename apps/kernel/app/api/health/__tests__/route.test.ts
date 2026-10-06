/**
 * GET /api/health (#2345): every entry in this route's SERVICES list must
 * resolve to a URL `fetch()` can actually parse. Before this fix,
 * `buildPublicUrl()` fell back to a bare relative path (e.g. "/input") once
 * neither an explicit `NEXT_PUBLIC_{NAME}_URL` env var nor an explicit
 * prefix/domain was supplied, and `fetch()` throws a `TypeError: Failed to
 * parse URL from /input` before any request is made — which permanently
 * marked prod "degraded" for a config bug rather than a real outage.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const SINGLE_DOMAIN_ENV = {
  NEXT_PUBLIC_SERVICE_PREFIX: 'https://jin.imajin.ai/',
  NEXT_PUBLIC_DOMAIN: 'imajin.ai',
} as const;

const CAUGHT_UP = { migrationHead: '0100_fixture.sql', appliedCount: 100, pendingCount: 0 };

// #2384: kernel reports its own migration state through the same
// @imajin/db helper (checkAppMigrations) every other app's own /api/health
// route uses. Mocked so these tests never need a real DATABASE_URL/Postgres
// connection; the default resolves "caught up" so it never accidentally
// trips the degraded assertions below. hasPendingMigrations is left real
// (via importOriginal) since it's pure logic with no DB dependency.
const { checkAppMigrationsMock } = vi.hoisted(() => ({ checkAppMigrationsMock: vi.fn() }));

// #2412: the route reports vault status via getVaultHealth(); mocked so these
// tests never touch the real filesystem/home directory. Defaults to a healthy
// vault so it never trips the degraded assertions below.
const { getVaultHealthMock } = vi.hoisted(() => ({ getVaultHealthMock: vi.fn() }));

vi.mock('@/src/lib/vault/vault-repository', () => ({ getVaultHealth: getVaultHealthMock }));

const HEALTHY_VAULT = {
  status: 'ok',
  path: '/home/jin/.imajin/vault.prod.json',
  entryCount: 12,
  lastLoadedAt: '2026-09-29T11:00:00.000Z',
  bootstrapped: false,
};

vi.mock('@imajin/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/db')>();
  return { ...actual, checkAppMigrations: checkAppMigrationsMock };
});

// Warm the route module's cold transitive import (config, db, vault) in a hook
// with an explicit budget. Left to the first `it()` it counted against the 5s
// testTimeout on a loaded CI runner (#2616). Modules are cached across tests
// here (no resetModules), so the per-test `import('../route')` below resolves
// instantly and still sees whatever env the test stubbed.
beforeAll(async () => {
  await import('../route');
}, 60_000);

beforeEach(() => {
  // Prod runs in single-domain mode (base URL + path) without a
  // NEXT_PUBLIC_INPUT_URL override — that's exactly the state that exposed
  // #2345, since the "input" service was retired (see
  // docs/migrations/retire-input-service.md) and its env var removed along
  // with it, while the SERVICES entry itself was left behind.
  for (const [key, value] of Object.entries(SINGLE_DOMAIN_ENV)) vi.stubEnv(key, value);
  delete process.env.NEXT_PUBLIC_INPUT_URL;

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  checkAppMigrationsMock.mockReset().mockResolvedValue(CAUGHT_UP);
  getVaultHealthMock.mockReset().mockResolvedValue(HEALTHY_VAULT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/health', () => {
  it('resolves a parseable, absolute URL for every configured service', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { services: { name: string; url: string }[] };

    expect(body.services.length).toBeGreaterThan(0);
    for (const service of body.services) {
      expect(() => new URL(service.url)).not.toThrow();
    }
  });

  it('resolves the input service to an absolute URL instead of a bare path (regression for #2345)', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { services: { name: string; url: string; status: string; error?: string }[] };

    const input = body.services.find((service) => service.name === 'input');
    expect(input?.url).toBe('https://jin.imajin.ai/input');
    expect(input?.error).toBeUndefined();
    expect(input?.status).not.toBe('down');
  });

  it('never leaves the whole kernel reporting degraded solely because of an unparseable service URL', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { status: string; services: { name: string; error?: string }[] };

    const parseFailures = body.services.filter((service) => service.error?.includes('Failed to parse URL'));
    expect(parseFailures).toEqual([]);
    expect(body.status).toBe('operational');
  });

  it("relays a service's migrations block verbatim and marks the aggregate degraded when it reports pending migrations (#2384)", async () => {
    const pendingMigrations = { migrationHead: '0050_learn_thing.sql', appliedCount: 50, pendingCount: 3 };

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const body = url.includes('/learn')
        ? { status: 'ok', service: 'learn', migrations: pendingMigrations }
        : { status: 'ok', migrations: CAUGHT_UP };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }));

    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as {
      status: string;
      migrations: typeof CAUGHT_UP;
      services: { name: string; migrations?: typeof pendingMigrations }[];
    };

    const learn = body.services.find((service) => service.name === 'learn');
    expect(learn?.migrations).toEqual(pendingMigrations);
    expect(body.migrations).toEqual(CAUGHT_UP);
    expect(body.status).toBe('degraded');
  });

  it('reports vault path, entry count and last-load time (#2412)', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { status: string; vault: typeof HEALTHY_VAULT };

    expect(body.vault).toEqual(HEALTHY_VAULT);
    expect(body.status).toBe('operational');
  });

  it('marks the aggregate degraded when the vault cannot be loaded (#2412)', async () => {
    getVaultHealthMock.mockResolvedValue({
      status: 'error',
      path: '/home/jin/.imajin/vault.prod.json',
      entryCount: null,
      lastLoadedAt: null,
      bootstrapped: false,
      error: 'VAULT_FILE_MISSING',
    });

    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { status: string; vault: { status: string; error: string } };

    expect(body.status).toBe('degraded');
    expect(body.vault.error).toBe('VAULT_FILE_MISSING');
  });

  it('marks the aggregate degraded for an EMPTY vault in production only (#2412)', async () => {
    getVaultHealthMock.mockResolvedValue({ ...HEALTHY_VAULT, status: 'empty', entryCount: 0 });
    const { GET } = await import('../route');

    const devBody = await (await GET()).json() as { status: string };
    expect(devBody.status).toBe('operational');

    vi.stubEnv('NODE_ENV', 'production');
    const prodBody = await (await GET()).json() as { status: string; vault: { entryCount: number } };
    expect(prodBody.status).toBe('degraded');
    expect(prodBody.vault.entryCount).toBe(0);
  });

  it('never leaks vault field names or values through the health body (#2412)', async () => {
    const { GET } = await import('../route');
    const body = await (await GET()).json() as { vault: Record<string, unknown> };

    expect(Object.keys(body.vault).sort((a, b) => a.localeCompare(b))).toEqual([
      'bootstrapped',
      'entryCount',
      'lastLoadedAt',
      'path',
      'status',
    ]);
  });
});
