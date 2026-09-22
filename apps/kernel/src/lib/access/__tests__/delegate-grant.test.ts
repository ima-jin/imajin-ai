/**
 * Unit tests for the delegate-grant bearer lifecycle (#2252): knock
 * validation, bearer issuance (sliding window vs. hard cap), resolution
 * (success + every denial reason), revocation (tombstone), and listing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  requestStore,
  bearerStore,
  mockGenerateOpaqueToken,
  mockHashToken,
  mockEmitAttestation,
  mockPublish,
  mockGetNodeDid,
} = vi.hoisted(() => ({
  requestStore: new Map<string, Record<string, unknown>>(),
  bearerStore: new Map<string, Record<string, unknown>>(),
  mockGenerateOpaqueToken: vi.fn(),
  // Deliberately NOT a substring-preserving "hash" (e.g. `hash(${token})`)
  // — that would make the "never stores the plaintext" assertions below
  // pass trivially even if the source code leaked the plaintext, since the
  // fake hash string would itself contain the plaintext substring.
  mockHashToken: vi.fn((token: string) => `h_${[...token].reverse().join('')}_${token.length}`),
  mockEmitAttestation: vi.fn().mockResolvedValue({}),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockGetNodeDid: vi.fn().mockResolvedValue('did:imajin:node'),
}));

vi.mock('@imajin/auth', () => ({ emitAttestation: mockEmitAttestation }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: mockGetNodeDid }));
vi.mock('@/src/lib/mcp/oauth-config', () => ({
  generateOpaqueToken: mockGenerateOpaqueToken,
  hashToken: mockHashToken,
  MCP_SCOPE_SET: new Set(['discovery:read', 'corpus:read', 'media:read']),
}));

// A purpose-built fake DB, mirroring the existing convention in
// `vault/__tests__/mint.test.ts`: `.limit()`/`.orderBy()` return everything
// currently in the relevant in-memory store rather than genuinely
// evaluating the WHERE-clause AST — each test only ever puts the ONE row it
// cares about in the store. The one exception is the sliding-expiry atomic
// UPDATE in `resolveDelegateGrantBearer`, which is fully mock-controlled
// via `updateBearersReturning` since its whole point is testing branching
// on "did the WHERE clause match", not replicating Postgres semantics.
const updateBearersReturning = vi.fn();

vi.mock('@/src/db', () => {
  const delegateGrantRequests = { __table: 'delegate_grant_requests', id: 'id', status: 'status' };
  const delegateGrantBearers = {
    __table: 'delegate_grant_bearers',
    tokenHash: 'tokenHash',
    status: 'status',
    expiresAt: 'expiresAt',
    hardCapAt: 'hardCapAt',
    surfaces: 'surfaces',
    slidingWindowDays: 'slidingWindowDays',
    principalDid: 'principalDid',
    issuedAt: 'issuedAt',
    id: 'id',
  };
  const storeFor = (table: { __table: string }) => (table.__table === 'delegate_grant_requests' ? requestStore : bearerStore);
  return {
    db: {
      insert: (table: { __table: string }) => ({
        values: (data: Record<string, unknown>) => {
          storeFor(table).set(data.id as string, data);
          return Promise.resolve([]);
        },
      }),
      select: () => ({
        from: (table: { __table: string }) => ({
          where: () => ({
            limit: () => Promise.resolve([...storeFor(table).values()]),
            orderBy: () => Promise.resolve([...storeFor(table).values()]),
          }),
        }),
      }),
      update: (table: { __table: string }) => ({
        set: (patch: Record<string, unknown>) => ({
          // Real drizzle's `.where(...)` returns a thenable query builder
          // that ALSO exposes `.returning()` — some call sites in
          // delegate-grant.ts bare-`await` the `.where(...)` result
          // directly (no `.returning()`), others chain `.returning()`.
          // Applying the mutation eagerly, once, when `.where()` is called
          // (rather than only inside a `.returning()` that might never be
          // invoked) is what makes both call shapes actually mutate the
          // store.
          where: () => {
            const apply = (): Promise<Record<string, unknown>[]> => {
              if (table.__table === 'delegate_grant_bearers' && !('tokenHash' in patch) && 'lastUsedAt' in patch) {
                // resolveDelegateGrantBearer's sliding-expiry UPDATE.
                return Promise.resolve(updateBearersReturning());
              }
              // Every other update (markExpired, mark request approved, revoke)
              // targets the single row currently in this table's store.
              const store = storeFor(table);
              const [row] = [...store.values()];
              if (!row) return Promise.resolve([]);
              const updated = { ...row, ...patch };
              store.set(row.id as string, updated);
              return Promise.resolve([updated]);
            };
            const resultPromise = apply();
            return Object.assign(resultPromise, { returning: () => resultPromise });
          },
        }),
      }),
    },
    delegateGrantRequests,
    delegateGrantBearers,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, value: unknown) => ({ __eq: value }),
  and: (...conditions: unknown[]) => ({ __and: conditions }),
  gt: (_col: unknown, value: unknown) => ({ __gt: value }),
  desc: (_col: unknown) => ({ __desc: true }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ __sql: strings.join('?'), values }),
}));

import {
  validateDelegateGrantKnockInput,
  createDelegateGrantKnock,
  issueDelegateGrantBearer,
  resolveDelegateGrantBearer,
  revokeDelegateGrantBearer,
  listDelegateGrantBearersForPrincipal,
  DELEGATE_GRANT_HARD_CAP_DAYS,
} from '../delegate-grant';

const PRINCIPAL_DID = 'did:imajin:ryan';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  requestStore.clear();
  bearerStore.clear();
  mockHashToken.mockImplementation((token: string) => `h_${[...token].reverse().join('')}_${token.length}`);
  mockGetNodeDid.mockResolvedValue('did:imajin:node');
  updateBearersReturning.mockResolvedValue([]);
});

describe('validateDelegateGrantKnockInput', () => {
  const base = {
    principalDid: PRINCIPAL_DID,
    clientLabel: 'Muse Code',
    purpose: 'read my media',
    scopes: ['discovery:read'],
    surfaces: ['mcp'],
  };

  it('accepts a well-formed knock', () => {
    expect(validateDelegateGrantKnockInput(base)).toEqual({ ok: true });
  });

  it('rejects an empty clientLabel', () => {
    const result = validateDelegateGrantKnockInput({ ...base, clientLabel: '  ' });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an empty purpose', () => {
    const result = validateDelegateGrantKnockInput({ ...base, purpose: '' });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an empty scopes array', () => {
    const result = validateDelegateGrantKnockInput({ ...base, scopes: [] });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a scope that is not MCP-carryable', () => {
    const result = validateDelegateGrantKnockInput({ ...base, scopes: ['not-a-real-scope'] });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an unsupported surface', () => {
    const result = validateDelegateGrantKnockInput({ ...base, surfaces: ['media'] });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects an empty surfaces array', () => {
    const result = validateDelegateGrantKnockInput({ ...base, surfaces: [] });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a slidingWindowDays outside the closed option set', () => {
    const result = validateDelegateGrantKnockInput({ ...base, slidingWindowDays: 45 });
    expect(result).toMatchObject({ ok: false });
  });

  it('accepts every valid slidingWindowDays option', () => {
    for (const days of [30, 90, 180, 365]) {
      expect(validateDelegateGrantKnockInput({ ...base, slidingWindowDays: days })).toEqual({ ok: true });
    }
  });
});

describe('createDelegateGrantKnock', () => {
  it('rejects invalid input without touching the database', async () => {
    const result = await createDelegateGrantKnock({
      principalDid: PRINCIPAL_DID,
      clientLabel: '',
      purpose: 'x',
      scopes: ['discovery:read'],
      surfaces: ['mcp'],
    });
    expect(result.ok).toBe(false);
    expect(requestStore.size).toBe(0);
  });

  it('creates a pending request expiring ~24h out and attests access.knock', async () => {
    const before = Date.now();
    const result = await createDelegateGrantKnock({
      principalDid: PRINCIPAL_DID,
      clientLabel: 'Muse Code',
      purpose: 'read my media',
      scopes: ['discovery:read'],
      surfaces: ['mcp'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expiresAtMs = Date.parse(result.expiresAt);
    expect(expiresAtMs - before).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(expiresAtMs - before).toBeLessThan(25 * 60 * 60 * 1000);

    const stored = requestStore.get(result.requestId);
    expect(stored).toMatchObject({ principalDid: PRINCIPAL_DID, status: 'pending', clientLabel: 'Muse Code' });

    expect(mockEmitAttestation).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.knock', subject_did: PRINCIPAL_DID }));
    expect(mockPublish).toHaveBeenCalledWith('access.knock.requested', expect.objectContaining({ subject: PRINCIPAL_DID }));
  });

  it('defaults slidingWindowDays to 90 when omitted', async () => {
    const result = await createDelegateGrantKnock({
      principalDid: PRINCIPAL_DID,
      clientLabel: 'Muse Code',
      purpose: 'p',
      scopes: ['discovery:read'],
      surfaces: ['mcp'],
    });
    expect(result.ok && result.slidingWindowDays).toBe(90);
  });
});

const AUTHORIZED_BY = {
  approvalId: 'aprop_1',
  operatorDid: 'did:imajin:operator',
  contentHash: 'a'.repeat(64),
  decidedAt: '2026-01-01T00:00:00.000Z',
};

function requestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'dgr_test',
    principalDid: PRINCIPAL_DID,
    clientLabel: 'Muse Code',
    purpose: 'read my media',
    scopes: ['discovery:read'],
    surfaces: ['mcp'],
    slidingWindowDays: 90,
    status: 'pending',
    expiresAt: new Date(Date.now() + ONE_DAY_MS),
    ...overrides,
  } as never;
}

describe('issueDelegateGrantBearer', () => {
  it('mints a bearer, stores only its hash, and returns the plaintext once', async () => {
    mockGenerateOpaqueToken.mockReturnValue('plaintext-secret');

    const result = await issueDelegateGrantBearer({
      request: requestRow(),
      issuedBy: 'did:imajin:node',
      authorizedBy: AUTHORIZED_BY,
    });

    expect(result.bearer).toBe('plaintext-secret');
    const stored = bearerStore.get(result.bearerId);
    expect(stored?.tokenHash).toBe(mockHashToken('plaintext-secret'));
    expect(JSON.stringify(stored)).not.toContain('plaintext-secret');
  });

  it('caps expiresAt at the hard cap even for a 365-day sliding window', async () => {
    mockGenerateOpaqueToken.mockReturnValue('t');
    const result = await issueDelegateGrantBearer({
      request: requestRow({ slidingWindowDays: 365 }),
      issuedBy: 'did:imajin:node',
      authorizedBy: AUTHORIZED_BY,
    });

    const expiresAtMs = Date.parse(result.expiresAt);
    const hardCapAtMs = Date.parse(result.hardCapAt);
    expect(expiresAtMs).toBe(hardCapAtMs);
    expect(hardCapAtMs - Date.now()).toBeLessThan((DELEGATE_GRANT_HARD_CAP_DAYS + 1) * ONE_DAY_MS);
  });

  it('uses the sliding window when it is shorter than the hard cap', async () => {
    mockGenerateOpaqueToken.mockReturnValue('t');
    const result = await issueDelegateGrantBearer({
      request: requestRow({ slidingWindowDays: 30 }),
      issuedBy: 'did:imajin:node',
      authorizedBy: AUTHORIZED_BY,
    });
    const expiresAtMs = Date.parse(result.expiresAt);
    expect(expiresAtMs - Date.now()).toBeLessThan(31 * ONE_DAY_MS);
    expect(expiresAtMs).toBeLessThan(Date.parse(result.hardCapAt));
  });

  it('marks the request approved and attests access.bearer.issued with the authorizedBy reference', async () => {
    mockGenerateOpaqueToken.mockReturnValue('t');
    const request = requestRow();
    requestStore.set(request.id, request);

    await issueDelegateGrantBearer({ request, issuedBy: 'did:imajin:node', authorizedBy: AUTHORIZED_BY });

    expect(requestStore.get(request.id)).toMatchObject({ status: 'approved' });
    expect(mockEmitAttestation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'access.bearer.issued',
      payload: expect.objectContaining({ authorizedBy: AUTHORIZED_BY }),
    }));
  });
});

describe('resolveDelegateGrantBearer', () => {
  it('authenticates a valid bearer, slides expiry, and emits access.bearer.used', async () => {
    const row = { id: 'dgb_1', principalDid: PRINCIPAL_DID, scopes: ['discovery:read'], surfaces: ['mcp'] };
    updateBearersReturning.mockResolvedValue([row]);

    const result = await resolveDelegateGrantBearer('plaintext', 'mcp');

    expect(result).toEqual({ ok: true, principalDid: PRINCIPAL_DID, scopes: ['discovery:read'], bearerId: 'dgb_1' });
    expect(mockEmitAttestation).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.bearer.used' }));
    expect(mockPublish).toHaveBeenCalledWith('access.bearer.used', expect.objectContaining({ subject: PRINCIPAL_DID }));
  });

  it('denies an unknown token without minting any attestation', async () => {
    updateBearersReturning.mockResolvedValue([]);

    const result = await resolveDelegateGrantBearer('garbage', 'mcp');

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(mockEmitAttestation).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('denies an expired-but-resolvable bearer and attests access.bearer.denied', async () => {
    updateBearersReturning.mockResolvedValue([]);
    bearerStore.set('dgb_2', { id: 'dgb_2', principalDid: PRINCIPAL_DID, surfaces: ['mcp'] });

    const result = await resolveDelegateGrantBearer('stale', 'mcp');

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect(mockEmitAttestation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'access.bearer.denied',
      payload: expect.objectContaining({ reason: 'expired' }),
    }));
  });

  it('denies a bearer presented against a surface it was never granted', async () => {
    updateBearersReturning.mockResolvedValue([]);
    bearerStore.set('dgb_3', { id: 'dgb_3', principalDid: PRINCIPAL_DID, surfaces: ['media'] });

    const result = await resolveDelegateGrantBearer('wrong-surface', 'mcp');

    expect(result).toEqual({ ok: false, reason: 'surface_miss' });
    expect(mockEmitAttestation).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ reason: 'surface_miss' }),
    }));
  });
});

describe('revokeDelegateGrantBearer', () => {
  it('returns not_found for an unknown bearer id', async () => {
    const result = await revokeDelegateGrantBearer({ bearerId: 'missing', requestedByDid: PRINCIPAL_DID });
    expect(result).toBe('not_found');
  });

  it('returns forbidden when the caller does not own the bearer', async () => {
    bearerStore.set('dgb_1', { id: 'dgb_1', principalDid: 'did:imajin:someone-else', status: 'active' });
    const result = await revokeDelegateGrantBearer({ bearerId: 'dgb_1', requestedByDid: PRINCIPAL_DID });
    expect(result).toBe('forbidden');
  });

  it('returns already_revoked idempotently', async () => {
    bearerStore.set('dgb_1', { id: 'dgb_1', principalDid: PRINCIPAL_DID, status: 'revoked' });
    const result = await revokeDelegateGrantBearer({ bearerId: 'dgb_1', requestedByDid: PRINCIPAL_DID });
    expect(result).toBe('already_revoked');
  });

  it('tombstones an active bearer: erases tokenHash, sets status revoked, attests access.bearer.revoked', async () => {
    bearerStore.set('dgb_1', { id: 'dgb_1', principalDid: PRINCIPAL_DID, status: 'active', clientLabel: 'Muse Code', tokenHash: 'hash(secret)' });

    const result = await revokeDelegateGrantBearer({ bearerId: 'dgb_1', requestedByDid: PRINCIPAL_DID });

    expect(result).toBe('revoked');
    const stored = bearerStore.get('dgb_1');
    expect(stored?.status).toBe('revoked');
    expect(stored?.tokenHash).toBeNull();
    expect(mockEmitAttestation).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.bearer.revoked' }));
    expect(mockPublish).toHaveBeenCalledWith('access.bearer.revoked', expect.objectContaining({ subject: PRINCIPAL_DID }));
  });
});

describe('listDelegateGrantBearersForPrincipal', () => {
  it('never includes tokenHash in the returned summaries', async () => {
    bearerStore.set('dgb_1', {
      id: 'dgb_1',
      principalDid: PRINCIPAL_DID,
      clientLabel: 'Muse Code',
      purpose: 'p',
      scopes: ['discovery:read'],
      surfaces: ['mcp'],
      status: 'active',
      tokenHash: 'hash(secret)',
      issuedAt: new Date(),
      lastUsedAt: null,
      expiresAt: new Date(),
      hardCapAt: new Date(),
    });

    const list = await listDelegateGrantBearersForPrincipal(PRINCIPAL_DID);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(list)).not.toContain('hash(secret)');
  });
});
