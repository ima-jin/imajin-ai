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
import { operationalRegistryRows } from '@/src/lib/kernel/__tests__/fixtures/third-party-app';

const { registryWhere } = vi.hoisted(() => ({ registryWhere: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: registryWhere }) }) },
  registryApps: { id: 'id', slug: 'slug', name: 'name', entryUrl: 'entry_url', status: 'status' },
}));

const SINGLE_DOMAIN_ENV = {
  NEXT_PUBLIC_SERVICE_PREFIX: 'https://jin.imajin.ai/',
  NEXT_PUBLIC_DOMAIN: 'imajin.ai',
} as const;

const CAUGHT_UP = { migrationHead: '0100_fixture.sql', appliedCount: 100, pendingCount: 0 };
function waitForAbort(_url: string, options: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
  });
}

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
  vi.stubEnv('APP_URL', 'https://jin.imajin.ai');
  registryWhere.mockResolvedValue(operationalRegistryRows);
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/health', () => {
  it('reports an unavailable registry explicitly instead of claiming a partial inventory is operational', async () => {
    registryWhere.mockRejectedValue(new Error('private database details'));
    const { GET } = await import('../route');
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', error: 'registry_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not append health paths to registered deep links, queries or fragments', async () => {
    registryWhere.mockResolvedValue([
      { id: 'deep', slug: 'deep', name: 'Deep', status: 'active', entryUrl: 'https://deep.example.test/start' },
      { id: 'query', slug: 'query', name: 'Query', status: 'active', entryUrl: 'https://query.example.test/?campaign=launch' },
      { id: 'hash', slug: 'hash', name: 'Hash', status: 'active', entryUrl: '/hash#start' },
    ]);
    const { GET } = await import('../route');
    await GET();
    expect(fetch).toHaveBeenCalledWith('https://deep.example.test/start', expect.any(Object));
    expect(fetch).toHaveBeenCalledWith('https://query.example.test/?campaign=launch', expect.any(Object));
    expect(fetch).toHaveBeenCalledWith('https://jin.imajin.ai/hash#start', expect.any(Object));
  });

  it('marks failed probes down and cleans up their timers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));
    const { GET } = await import('../route');
    const body = await (await GET()).json();
    expect(body.status).toBe('degraded');
    expect(body.services.every((service: { status: string; error: string; kind: string }) =>
      service.status === 'down' && service.error === 'network unavailable' && service.kind)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts timed-out probes and reports a null elapsed time', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(waitForAbort));
    const { GET } = await import('../route');
    const pending = GET();
    await vi.advanceTimersByTimeAsync(10000);
    const body = await (await pending).json();
    expect(body.services.every((service: { status: string; responseTime: number | null }) =>
      service.status === 'down' && service.responseTime === null)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports non-Error probe failures without exposing arbitrary values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('secret-ish failure'));
    const { GET } = await import('../route');
    const body = await (await GET()).json();
    expect(body.services.every((service: { error: string }) => service.error === 'Unknown error')).toBe(true);
  });

  it('marks server errors degraded while treating redirects and auth failures as alive', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(
      new Response(null, { status: url.includes('studio.example.test') ? 503 : 401 }),
    )));
    const { GET } = await import('../route');
    const body = await (await GET()).json();
    expect(body.status).toBe('degraded');
    expect(body.services.find((service: { name: string }) => service.name === 'fixture-studio').status).toBe('degraded');
    expect(body.services.find((service: { name: string }) => service.name === 'auth').status).toBe('up');
  });
  it('does not probe deleted coffee/dykil/links port hints as kernel URLs', async () => {
    const { GET } = await import('../route');
    const body = await (await GET()).json() as { services: { name: string }[] };
    expect(body.services.some((service) => ['coffee', 'dykil', 'links'].includes(service.name))).toBe(false);
  });
  it('resolves a parseable, absolute URL for every configured service', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { services: { name: string; url: string }[] };

    expect(body.services.length).toBeGreaterThan(0);
    for (const service of body.services) {
      expect(() => new URL(service.url)).not.toThrow();
    }
  });

  it('probes the active fixture app at its registered destination without kernel/env edits', async () => {
    vi.stubEnv('NEXT_PUBLIC_FIXTURE-STUDIO_URL', 'https://override.example.test');
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as { services: { name: string; url: string; status: string; error?: string }[] };

    const studio = body.services.find((service) => service.name === 'fixture-studio');
    expect(studio).toMatchObject({ label: 'Fixture Studio', kind: 'app', url: 'https://studio.example.test/', status: 'up' });
    expect(studio?.error).toBeUndefined();
    expect(body.services.some(service => ['input', 'events', 'revoked-app', 'unsafe-app', 'missing-url'].includes(service.name))).toBe(false);
    expect(fetch).toHaveBeenCalledWith('https://studio.example.test/api/health', expect.objectContaining({ redirect: 'manual' }));
    expect(fetch).toHaveBeenCalledWith('https://jin.imajin.ai/relative-app/api/health', expect.any(Object));
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
      const body = url.includes('studio.example.test')
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

    const studio = body.services.find((service) => service.name === 'fixture-studio');
    expect(studio?.migrations).toEqual(pendingMigrations);
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
