/**
 * Every vault route that reads or writes a field name refuses an invalid one
 * with a 400 from the shared grammar (#2699), before touching the vault, the
 * DB, or the bus — and hands the TRIMMED name (never a case-folded one) to
 * whatever it calls next.
 *
 * Only the vault/db/auth edges are mocked; the real `field-grammar` runs.
 * `field-grammar.consistency.test.ts` separately pins that each of these routes
 * delegates to the grammar rather than carrying its own check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => true),
  sealAndStore: vi.fn(),
  sealAndStoreV2: vi.fn(),
  loadAndUnseal: vi.fn(),
  vaultGet: vi.fn(),
  vaultPeek: vi.fn(),
  vaultGetHistory: vi.fn(),
  getRotateGranteeGuard: vi.fn(),
  migrateCustody: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.requireAdmin, verifySync: vi.fn() }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/src/db', () => ({ db: {}, vaultDelegationGrants: {}, vaultGrantRequests: {} }));
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: vi.fn() }));
vi.mock('@/src/lib/vault', () => ({
  sealAndStore: mocks.sealAndStore,
  sealAndStoreV2: mocks.sealAndStoreV2,
  loadAndUnseal: mocks.loadAndUnseal,
  vaultService: { get: mocks.vaultGet, peek: mocks.vaultPeek, getHistory: mocks.vaultGetHistory },
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }) }));
vi.mock('@/src/lib/vault/subscribe', () => ({ ensureVaultHotReloadReactorRegistered: vi.fn() }));
vi.mock('@/src/lib/vault/grantees', () => ({ getRotateGranteeGuard: mocks.getRotateGranteeGuard }));
vi.mock('@/src/lib/vault/migrate-custody', () => ({ migrateCustody: mocks.migrateCustody }));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

const NEVER_REACHED = [
  mocks.sealAndStore,
  mocks.sealAndStoreV2,
  mocks.loadAndUnseal,
  mocks.vaultGet,
  mocks.vaultPeek,
  mocks.vaultGetHistory,
  mocks.getRotateGranteeGuard,
  mocks.migrateCustody,
  mocks.publish,
];

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/vault/${path}`, { method: 'POST', body: JSON.stringify(body) });
}

function expectNothingReached(): void {
  for (const spy of NEVER_REACHED) {
    expect(spy).not.toHaveBeenCalled();
  }
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

const GRANT_BODY = {
  subject: 'did:imajin:owner',
  grantedTo: 'did:imajin:node',
  ownerXPub: 'xpub',
  wrappedKey: 'wk',
  wrappedNonce: 'wn',
  keyId: 'k1',
  ownerSignature: 'sig',
};

const BODY_ROUTES: [string, () => Promise<{ POST: (r: never) => Promise<Response> }>, (field: unknown) => unknown][] = [
  ['set', () => import('../set/route'), (field) => ({ field, value: 'secret' })],
  ['rotate', () => import('../rotate/route'), (field) => ({ field, value: 'secret' })],
  ['upgrade-custody', () => import('../upgrade-custody/route'), (field) => ({ field })],
  ['delegation/revoke', () => import('../delegation/revoke/route'), (field) => ({ field })],
  ['delegation/grant', () => import('../delegation/grant/route'), (field) => ({ ...GRANT_BODY, field })],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(true);
});

describe.each(BODY_ROUTES)('POST /api/vault/%s', (path, load, bodyFor) => {
  it.each([
    ['a trailing colon', 'internal-secret:'],
    ['an empty segment', 'a::b'],
    ['inner whitespace', 'gh token'],
    ['a slash', 'a/b'],
  ])('400s on %s without touching the vault', async (_label, field) => {
    const { POST } = await load();
    const response = await POST(post(path, bodyFor(field)) as never);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain('not a valid vault field name');
    expectNothingReached();
  });
});

describe.each(BODY_ROUTES.filter(([path]) => path !== 'delegation/grant'))('POST /api/vault/%s — missing field', (path, load, bodyFor) => {
  it.each([
    ['undefined', undefined],
    ['blank', '   '],
    ['not a string', 42],
  ])('400s "field is required" when field is %s', async (_label, field) => {
    const { POST } = await load();
    const response = await POST(post(path, bodyFor(field)) as never);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('field is required');
    expectNothingReached();
  });
});

describe('POST /api/vault/delegation/grant — signed field', () => {
  it('400s a field with surrounding whitespace rather than silently trimming what the owner signed', async () => {
    const { POST } = await import('../delegation/grant/route');
    const response = await POST(post('delegation/grant', { ...GRANT_BODY, field: ' GH_TOKEN' }) as never);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('field must not have leading or trailing whitespace');
    expectNothingReached();
  });
});

describe('POST /api/vault/set — accepted shapes', () => {
  it('hands the trimmed, case-preserved field to the vault', async () => {
    mocks.vaultGet.mockResolvedValue(null);
    mocks.sealAndStoreV2.mockResolvedValue({ entry: { field: 'x', cid: 'c', timestamp: 't', senderDid: 'd' }, grantId: 'g' });
    const { POST } = await import('../set/route');
    const response = await POST(
      post('set', { field: '  warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT ', value: 'secret', custodyScheme: 'delegation-grant' }) as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.vaultGet).toHaveBeenCalledWith('warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT');
    expect(mocks.sealAndStoreV2.mock.calls[0][0]).toBe('warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT');
  });
});

describe.each([
  ['GET /api/vault/history/[field]', () => import('../history/[field]/route')],
  ['GET /api/vault/grantees/[field]', () => import('../grantees/[field]/route')],
])('%s', (_name, load) => {
  it.each([
    ['an empty segment', 'a::b'],
    ['a trailing colon', 'internal-secret:'],
    ['whitespace', 'gh token'],
  ])('400s on %s without touching the vault', async (_label, field) => {
    const { GET } = await load();
    const response = await GET(new Request('http://localhost/api/vault/x') as never, { params: Promise.resolve({ field }) });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain('not a valid vault field name');
    expectNothingReached();
  });
});

describe('POST /api/vault/migrate-custody — fields[]', () => {
  it('400s when any entry is not a valid field name, and migrates nothing', async () => {
    const { POST } = await import('../migrate-custody/route');
    const response = await POST(post('migrate-custody', { fields: ['GH_TOKEN', 'a::b'] }) as never);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain('not a valid vault field name');
    expectNothingReached();
  });

  it.each([
    ['an empty array', []],
    ['a non-array', 'GH_TOKEN'],
  ])('400s on %s', async (_label, fields) => {
    const { POST } = await import('../migrate-custody/route');
    const response = await POST(post('migrate-custody', { fields }) as never);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('fields must be a non-empty array of vault field names');
    expectNothingReached();
  });

  it('passes the trimmed field names through', async () => {
    mocks.migrateCustody.mockResolvedValue({ results: [] });
    const { POST } = await import('../migrate-custody/route');
    await POST(post('migrate-custody', { fields: [' GH_TOKEN ', 'internal-secret:x'] }) as never);
    expect(mocks.migrateCustody).toHaveBeenCalledWith(expect.objectContaining({ fields: ['GH_TOKEN', 'internal-secret:x'] }));
  });
});

describe('POST /api/vault/rotation-sweep — reimport', () => {
  const reimport = (fields: unknown[]) => post('rotation-sweep', { phase: 'reimport', fields });

  it('400s an entry with an invalid field name and re-seals nothing', async () => {
    const { POST } = await import('../rotation-sweep/route');
    const response = await POST(reimport([{ field: 'a:', plaintext: 'x' }]) as never);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain('not a valid vault field name');
    expectNothingReached();
  });

  it('400s an entry with no field name', async () => {
    const { POST } = await import('../rotation-sweep/route');
    const response = await POST(reimport([{ plaintext: 'x' }]) as never);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toContain('field is required');
    expectNothingReached();
  });

  it('re-seals under the trimmed field name', async () => {
    mocks.sealAndStoreV2.mockResolvedValue({ entry: {}, grantId: 'g' });
    const { POST } = await import('../rotation-sweep/route');
    const response = await POST(reimport([{ field: ' internal-secret:kernel.pepper ', plaintext: 'x' }]) as never);
    expect(response.status).toBe(200);
    expect(mocks.sealAndStoreV2).toHaveBeenCalledWith('internal-secret:kernel.pepper', 'x');
  });
});
