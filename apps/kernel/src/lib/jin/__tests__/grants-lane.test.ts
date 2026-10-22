import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockInnerJoinWhere,
  mockWhereQueue,
  pushWhereResult,
  resetWhereQueue,
  mockListGrantDetailsForDelegator,
  mockListVaultKeyCards,
  mockListDelegateGrantBearersForPrincipal,
  mockMintedKeyField,
} = vi.hoisted(() => {
  let queue: unknown[][] = [];
  const pushWhereResult = (rows: unknown[]) => queue.push(rows);
  const resetWhereQueue = () => { queue = []; };

  function queryableResult(rows: unknown[]) {
    const p = Promise.resolve(rows);
    return {
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
    };
  }

  const mockInnerJoinWhere = vi.fn(() => queryableResult(queue.length > 0 ? queue.shift()! : []));
  const mockWhere = vi.fn(() => queryableResult(queue.length > 0 ? queue.shift()! : []));
  const mockDbSelect = vi.fn(() => ({
    from: vi.fn(() => ({
      where: mockWhere,
      innerJoin: vi.fn(() => ({ where: mockInnerJoinWhere })),
    })),
  }));

  return {
    mockDbSelect,
    mockInnerJoinWhere,
    mockWhereQueue: mockWhere,
    pushWhereResult,
    resetWhereQueue,
    mockListGrantDetailsForDelegator: vi.fn(),
    mockListVaultKeyCards: vi.fn(),
    mockListDelegateGrantBearersForPrincipal: vi.fn(),
    mockMintedKeyField: vi.fn((did: string) => `vault-minted-key:${did}`),
  };
});

describe('live app authorization grouping (#3008)', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  function app(overrides: Partial<AppAuthorizationSummary> = {}): AppAuthorizationSummary {
    return {
      attestationId: 'att_1', appDid: 'did:imajin:karaoke', appName: 'Karaoke',
      scopes: ['profile:read'], authorizedAt: '2026-10-20T10:00:00.000Z',
      revokedAt: null, expiresAt: null, ...overrides,
    };
  }

  it.each([
    { recordedLastUsedAt: '2026-10-20T11:00:00Z', oauthLastUsedAt: '2026-10-19T12:00:00Z', expected: '2026-10-20T11:00:00Z' },
    { recordedLastUsedAt: '2026-10-19T12:00:00Z', oauthLastUsedAt: '2026-10-20T11:00:00Z', expected: '2026-10-20T11:00:00Z' },
    { recordedLastUsedAt: null, oauthLastUsedAt: '2026-10-20T11:00:00Z', expected: '2026-10-20T11:00:00Z' },
    { recordedLastUsedAt: '2026-10-20T11:00:00Z', oauthLastUsedAt: null, expected: '2026-10-20T11:00:00Z' },
    { recordedLastUsedAt: null, oauthLastUsedAt: null, expected: null },
    { recordedLastUsedAt: '2026-10-20T12:00:00+02:00', oauthLastUsedAt: '2026-10-20T11:00:00Z', expected: '2026-10-20T11:00:00Z' },
  ])('picks newest evidence for this attestation: %j', ({ expected, ...usage }) => {
    expect(normalizeAppAuthorizations([app(usage)], now)[0].lastUsedAt).toBe(expected);
  });

  it('distinguishes unrecorded pre-ship history from newly issued never-used grants', () => {
    expect(normalizeAppAuthorizations([app()], now)[0].lastUsedNotRecordedBefore).toBe('2026-10-22');
    const shipped = Date.parse('2026-10-22T00:00:00.000Z');
    expect(normalizeAppAuthorizations([app({ authorizedAt: new Date(shipped).toISOString() })], shipped)[0].lastUsedNotRecordedBefore).toBeUndefined();
    expect(normalizeAppAuthorizations([app({ oauthLastUsedAt: '2026-10-20T11:00:00Z' })], now)[0].lastUsedNotRecordedBefore).toBeUndefined();
  });

  it('does not borrow usage evidence from another app or a surplus attestation', () => {
    const cards = normalizeAppAuthorizations([
      app({ attestationId: 'old', authorizedAt: '2026-10-19T00:00:00Z', recordedLastUsedAt: '2026-10-20T11:00:00Z' }),
      app({ attestationId: 'new' }),
      app({ attestationId: 'different-app', appDid: 'did:imajin:other', oauthLastUsedAt: '2026-10-20T11:00:00Z' }),
    ], now);
    expect(cards.find(card => card.id === 'app-authorization:new')?.lastUsedAt).toBeNull();
  });

  it('collapses ten live grants to newest plus nine exact surplus ids without mutating input', () => {
    const apps = Array.from({ length: 10 }, (_, index) => app({
      attestationId: `att_${index}`,
      authorizedAt: `2026-10-20T10:0${index}:00.000Z`,
      scopes: [`scope:${index}`],
    }));
    const before = structuredClone(apps);
    const cards = normalizeAppAuthorizations(apps, now);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'app-authorization:att_9', appDid: 'did:imajin:karaoke',
      capabilities: ['scope:9'], surplusGrantIds: ['att_8', 'att_7', 'att_6', 'att_5', 'att_4', 'att_3', 'att_2', 'att_1', 'att_0'],
      revoke: { method: 'POST', path: '/api/auth/revoke', body: { attestationId: 'att_9' } },
    });
    expect(apps).toEqual(before);
  });

  it('groups by DID despite renamed labels and never combines equal labels across DIDs', () => {
    const cards = normalizeAppAuthorizations([
      app({ attestationId: 'a', appName: 'Old Karaoke' }),
      app({ attestationId: 'b' }),
      app({ attestationId: 'other', appDid: 'did:imajin:other' }),
    ], now);
    expect(cards).toHaveLength(2);
    expect(cards.find(card => card.appDid === 'did:imajin:karaoke')).toMatchObject({
      grantee: 'Karaoke', surplusGrantIds: ['a'],
    });
    expect(cards.find(card => card.appDid === 'did:imajin:other')?.surplusGrantIds).toBeUndefined();
  });

  it('compares actual instants, then greatest attestation id for tied issue times regardless of input order', () => {
    const apps = [
      app({ attestationId: 'z', authorizedAt: '2026-10-20T11:00:00+02:00' }),
      app({ attestationId: 'b', authorizedAt: '2026-10-20T10:00:00Z' }),
      app({ attestationId: 'a', authorizedAt: '2026-10-20T10:00:00.000Z' }),
    ];
    for (const input of [apps, [...apps].reverse()]) {
      expect(normalizeAppAuthorizations(input, now)[0]).toMatchObject({
        id: 'app-authorization:b', surplusGrantIds: ['a', 'z'],
      });
    }
  });

  it('excludes revoked and expired (including exactly now) from live count and cleanup', () => {
    const cards = normalizeAppAuthorizations([
      app({ attestationId: 'live' }),
      app({ attestationId: 'future', expiresAt: '2026-10-20T12:00:00.001Z' }),
      app({ attestationId: 'expired', expiresAt: '2026-10-20T11:59:59.999Z' }),
      app({ attestationId: 'boundary', expiresAt: '2026-10-20T12:00:00.000Z' }),
      app({ attestationId: 'revoked', revokedAt: '2026-10-20T11:00:00.000Z' }),
      app({ attestationId: 'both', revokedAt: '2026-10-20T11:00:00.000Z', expiresAt: '2026-10-20T11:00:00.000Z' }),
    ], now);
    expect(cards).toHaveLength(5);
    expect(cards.find(card => card.status === 'active')).toMatchObject({
      id: 'app-authorization:live', surplusGrantIds: ['future'],
    });
    expect(cards.filter(card => card.status === 'expired')).toHaveLength(2);
    expect(cards.filter(card => card.status === 'revoked')).toHaveLength(2);
    for (const card of cards.filter(card => card.status !== 'active')) {
      expect(card.revocable).toBe(false);
      expect(card.revoke).toBeNull();
      expect(card.surplusGrantIds).toBeUndefined();
    }
  });

  it('preserves the existing single-grant revoke shape and handles no grants', () => {
    expect(normalizeAppAuthorizations([], now)).toEqual([]);
    const [card] = normalizeAppAuthorizations([app()], now);
    expect(card.surplusGrantIds).toBeUndefined();
    expect(card).toMatchObject({ status: 'active', revocable: true, revoke: { body: { attestationId: 'att_1' } } });
  });

  it('uses deterministic case-sensitive id ordering rather than locale collation', () => {
    const cards = normalizeAppAuthorizations([
      app({ attestationId: 'att_A' }), app({ attestationId: 'att_a' }),
    ], now);
    expect(cards[0]).toMatchObject({ id: 'app-authorization:att_a', surplusGrantIds: ['att_A'] });
  });
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  identities: { id: 'identities.id', subtype: 'identities.subtype', scope: 'identities.scope' },
  identityMembers: {
    identityDid: 'identityMembers.identityDid',
    memberDid: 'identityMembers.memberDid',
    role: 'identityMembers.role',
    addedAt: 'identityMembers.addedAt',
    removedAt: 'identityMembers.removedAt',
  },
  attestations: {
    id: 'attestations.id',
    subjectDid: 'attestations.subjectDid',
    issuerDid: 'attestations.issuerDid',
    type: 'attestations.type',
    payload: 'attestations.payload',
    issuedAt: 'attestations.issuedAt',
    revokedAt: 'attestations.revokedAt',
    expiresAt: 'attestations.expiresAt',
  },
  registryApps: { appDid: 'registryApps.appDid', name: 'registryApps.name' },
  appAuthorizationUsage: { lastUsedAt: 'usage.lastUsedAt', attestationId: 'usage.attestationId' },
  oauthRefreshTokens: { createdAt: 'refresh.createdAt', attestationId: 'refresh.attestationId' },
}));
vi.mock('@/src/lib/vault/import-authority', () => ({
  listImportOwners: vi.fn(async (did: string) => [{ did, name: did }]),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('@/src/lib/auth/grants', () => ({
  listGrantDetailsForDelegator: mockListGrantDetailsForDelegator,
}));

vi.mock('@/src/lib/vault', () => ({
  listVaultKeyCards: mockListVaultKeyCards,
}));

vi.mock('@/src/lib/vault/mint', () => ({
  mintedKeyField: mockMintedKeyField,
}));

vi.mock('@/src/lib/access/delegate-grant', () => ({
  listDelegateGrantBearersForPrincipal: mockListDelegateGrantBearersForPrincipal,
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import {
  listLegacyAgentMemberships,
  listAppAuthorizationsForOwner,
  listGrantsForOperator,
  listAuthGrantsForDelegator,
  normalizeAppAuthorizations,
  type AppAuthorizationSummary,
} from '../grants-lane';
import { listImportOwners } from '@/src/lib/vault/import-authority';

const OPERATOR_DID = 'did:imajin:operator';

beforeEach(() => {
  vi.clearAllMocks();
  resetWhereQueue();
  mockListGrantDetailsForDelegator.mockResolvedValue([]);
  mockListVaultKeyCards.mockResolvedValue([]);
  mockListDelegateGrantBearersForPrincipal.mockResolvedValue([]);
});

describe('listLegacyAgentMemberships', () => {
  it('maps identity_members rows into legacy membership summaries', async () => {
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([
      { agentDid: 'did:imajin:jin', role: 'owner', addedAt: new Date('2026-01-01T00:00:00.000Z') },
    ]));

    const result = await listLegacyAgentMemberships(OPERATOR_DID);

    expect(result).toEqual([
      { agentDid: 'did:imajin:jin', role: 'owner', addedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('returns an empty array when there are no memberships', async () => {
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([]));
    await expect(listLegacyAgentMemberships(OPERATOR_DID)).resolves.toEqual([]);
  });
});

describe('listAppAuthorizationsForOwner', () => {
  it('joins app metadata onto each authorization', async () => {
    pushWhereResult([
      {
        attestationId: 'att_1',
        appDid: 'did:imajin:app1',
        payload: { scopes: ['supply:read'] },
        issuedAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: null,
        expiresAt: null,
      },
    ]);
    pushWhereResult([{ appDid: 'did:imajin:app1', name: 'Muse Code' }]);

    const result = await listAppAuthorizationsForOwner(OPERATOR_DID);
    expect(mockDbSelect).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: 'attestations.expiresAt' }));

    expect(result).toEqual([
      {
        attestationId: 'att_1',
        appDid: 'did:imajin:app1',
        appName: 'Muse Code',
        scopes: ['supply:read'],
        authorizedAt: '2026-02-01T00:00:00.000Z',
        revokedAt: null,
        expiresAt: null,
        recordedLastUsedAt: null,
        oauthLastUsedAt: null,
      },
    ]);
  });

  it('falls back to the appDid when no registry app row is found', async () => {
    pushWhereResult([
      { attestationId: 'att_2', appDid: 'did:imajin:app2', payload: null, issuedAt: new Date('2026-02-02T00:00:00.000Z'), revokedAt: null },
    ]);
    pushWhereResult([]);

    const result = await listAppAuthorizationsForOwner(OPERATOR_DID);
    expect(result[0]!.appName).toBe('did:imajin:app2');
    expect(result[0]!.scopes).toEqual([]);
  });

  it('short-circuits without a second query when there are no authorizations', async () => {
    pushWhereResult([]);
    const result = await listAppAuthorizationsForOwner(OPERATOR_DID);
    expect(result).toEqual([]);
    expect(mockWhereQueue).toHaveBeenCalledTimes(1);
  });

  it('reads persisted expiration through to non-live normalization', async () => {
    pushWhereResult([{
      attestationId: 'expired', appDid: 'did:imajin:app', payload: null,
      issuedAt: new Date('2026-10-20T10:00:00.000Z'), revokedAt: null,
      expiresAt: new Date('2026-10-20T12:00:00.000Z'),
    }]);
    pushWhereResult([]);
    const apps = await listAppAuthorizationsForOwner(OPERATOR_DID);
    expect(apps[0].expiresAt).toBe('2026-10-20T12:00:00.000Z');
    expect(normalizeAppAuthorizations(apps, Date.parse(apps[0].expiresAt!))[0]).toMatchObject({
      status: 'expired', revocable: false, revoke: null,
    });
  });
});

describe('listAuthGrantsForDelegator (#2997)', () => {
  it('reads only the org auth source, preserving human history and org delegator', async () => {
    const delegatorDid = 'did:imajin:org';
    const history = [{ event: 'issued', actorDid: 'did:imajin:owner', createdAt: '2026-03-01T00:00:00.000Z', capability: null }];
    mockListGrantDetailsForDelegator.mockResolvedValue([
      { grantId: 'older', delegatorDid, history, agentDid: 'did:imajin:bot', capabilities: [], issuedAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, status: 'revoked' },
      { grantId: 'newer', delegatorDid, history, agentDid: 'did:imajin:bot', capabilities: [{ capability: 'messages:write', status: 'active' }], issuedAt: '2026-03-01T00:00:00.000Z', lastUsedAt: null, status: 'active' },
    ]);
    const cards = await listAuthGrantsForDelegator(delegatorDid);
    expect(mockListGrantDetailsForDelegator).toHaveBeenCalledWith(delegatorDid);
    expect(cards.map((card) => card.id)).toEqual(['auth-grant:newer', 'auth-grant:older']);
    expect(cards[0]).toMatchObject({ source: 'auth-grant', delegatorDid, history, revocable: true });
    expect(cards[1]).toMatchObject({ revocable: false, revoke: null });
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockListVaultKeyCards).not.toHaveBeenCalled();
    expect(mockListDelegateGrantBearersForPrincipal).not.toHaveBeenCalled();
  });
});

describe('listGrantsForOperator', () => {
  it('shows group zone grants through the existing revoke lane, but not unrelated group grants', async () => {
    vi.mocked(listImportOwners).mockResolvedValueOnce([
      { did: OPERATOR_DID, name: 'Operator' }, { did: 'did:imajin:group', name: 'Group' },
    ]);
    mockListGrantDetailsForDelegator.mockImplementation(async (did: string) => did === OPERATOR_DID ? [] : [
      { grantId: 'zone-grant', agentDid: 'did:web:external.example', capabilities: [{ capability: 'cloudflare:dns', status: 'active' }],
        audience: { type: 'dids', values: [`did:imajin:cloudflare-${'a'.repeat(32)}`] }, issuedAt: '2026-10-20T00:00:00Z', status: 'active' },
      { grantId: 'other-grant', agentDid: 'did:imajin:other', capabilities: [{ capability: 'messages:read', status: 'active' }],
        audience: { type: 'all' }, issuedAt: '2026-10-20T00:00:00Z', status: 'active' },
    ]);
    const cards = await listGrantsForOperator(OPERATOR_DID);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      grantee: 'did:web:external.example', capabilities: ['cloudflare:dns'],
      revoke: { method: 'DELETE', path: '/auth/api/grants/zone-grant' },
    });
  });
  it('normalizes every source into one sorted GrantCard list', async () => {
    mockListGrantDetailsForDelegator.mockResolvedValue([
      {
        grantId: 'grant_1',
        agentDid: 'did:imajin:agent1',
        capabilities: [{ capability: 'messages:write', status: 'active', revokedAt: null }],
        issuedAt: '2026-03-01T00:00:00.000Z',
        lastUsedAt: '2026-03-02T00:00:00.000Z',
        status: 'active',
      },
    ]);
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([
      { agentDid: 'did:imajin:legacy1', role: 'owner', addedAt: new Date('2026-01-15T00:00:00.000Z') },
    ]));
    mockListVaultKeyCards.mockResolvedValue([
      {
        did: 'did:imajin:vaultkey1',
        purpose: 'signing key',
        createdAt: '2026-01-01T00:00:00.000Z',
        timeline: [
          { type: 'minted', at: '2026-01-01T00:00:00.000Z', detail: {} },
          { type: 'granted', at: '2026-01-02T00:00:00.000Z', detail: {} },
        ],
        grant: {
          grantId: 'vdg_1',
          grantedTo: 'did:imajin:consumer1',
          purpose: 'gha-runner',
          status: 'active',
          expiresAt: null,
          consumedAt: null,
          lastFetchedAt: null,
          ackedAt: null,
          ackOutcome: null,
          ackEvidence: null,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        grants: [],
      },
    ]);
    mockListDelegateGrantBearersForPrincipal.mockResolvedValue([
      {
        bearerId: 'dgb_1',
        clientLabel: 'Muse Code',
        scopes: ['discovery:read'],
        status: 'active',
        issuedAt: '2026-02-15T00:00:00.000Z',
        lastUsedAt: null,
      },
    ]);
    pushWhereResult([
      { attestationId: 'att_1', appDid: 'did:imajin:app1', payload: { scopes: ['supply:read'] }, issuedAt: new Date('2026-02-20T00:00:00.000Z'), revokedAt: null },
    ]);
    pushWhereResult([{ appDid: 'did:imajin:app1', name: 'Muse App' }]);

    const result = await listGrantsForOperator(OPERATOR_DID);

    expect(result).toHaveLength(5);
    expect(result.map((c) => c.source).sort()).toEqual([
      'access-bearer',
      'app-authorization',
      'auth-grant',
      'auth-membership',
      'vault-delegation',
    ].sort());

    // Sorted newest-issued first.
    expect(result[0]!.issuedAt! >= result[result.length - 1]!.issuedAt!).toBe(true);

    const authGrantCard = result.find((c) => c.source === 'auth-grant')!;
    expect(authGrantCard.lastUsedAt).toBe('2026-03-02T00:00:00.000Z');
    expect(authGrantCard).toMatchObject({
      id: 'auth-grant:grant_1',
      grantee: 'did:imajin:agent1',
      capabilities: ['messages:write'],
      revoke: { method: 'DELETE', path: '/auth/api/grants/grant_1' },
    });

    const membershipCard = result.find((c) => c.source === 'auth-membership')!;
    expect(membershipCard).toMatchObject({
      id: 'auth-membership:did:imajin:legacy1',
      grantee: 'did:imajin:legacy1',
      capabilities: ['owner'],
      revoke: { method: 'DELETE', path: '/auth/api/agents/did%3Aimajin%3Alegacy1' },
    });

    const vaultCard = result.find((c) => c.source === 'vault-delegation')!;
    expect(vaultCard.lastUsedAt).toBeNull();
    expect(vaultCard).toMatchObject({
      id: 'vault-delegation:vdg_1',
      grantee: 'did:imajin:consumer1',
      capabilities: ['gha-runner'],
      issuedAt: '2026-01-02T00:00:00.000Z',
      ackState: null,
      revoke: { method: 'POST', path: '/api/vault/delegation/revoke', body: { field: 'vault-minted-key:did:imajin:vaultkey1' } },
    });

    const bearerCard = result.find((c) => c.source === 'access-bearer')!;
    expect(bearerCard.lastUsedAt).toBeNull();
    expect(bearerCard).toMatchObject({
      id: 'access-bearer:dgb_1',
      grantee: 'Muse Code',
      capabilities: ['discovery:read'],
      revoke: { method: 'POST', path: '/auth/api/access/bearers/dgb_1/revoke' },
    });

    const appCard = result.find((c) => c.source === 'app-authorization')!;
    expect(appCard).toMatchObject({
      id: 'app-authorization:att_1',
      grantee: 'Muse App',
      capabilities: ['supply:read'],
      revoke: { method: 'POST', path: '/api/auth/revoke', body: { attestationId: 'att_1' } },
    });
  });

  it('maps vault deferred-ack outcomes, including "pending" for a fetched-but-unacked grant', async () => {
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([]));
    pushWhereResult([]);
    mockListVaultKeyCards.mockResolvedValue([
      {
        did: 'did:imajin:vaultkey2',
        purpose: 'signing key',
        createdAt: '2026-01-01T00:00:00.000Z',
        timeline: [{ type: 'granted', at: '2026-01-02T00:00:00.000Z', detail: {} }],
        grant: {
          grantId: 'vdg_2',
          grantedTo: 'did:imajin:consumer2',
          purpose: null,
          status: 'active',
          expiresAt: null,
          consumedAt: null,
          lastFetchedAt: '2026-01-03T00:00:00.000Z',
          ackedAt: null,
          ackOutcome: null,
          ackEvidence: null,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        grants: [],
      },
    ]);

    const result = await listGrantsForOperator(OPERATOR_DID);
    const vaultCard = result.find((c) => c.source === 'vault-delegation')!;
    expect(vaultCard.ackState).toBe('pending');
    expect(vaultCard.capabilities).toEqual(['signing key']);
  });

  it('excludes a minted key with no associated grant from the vault-delegation source', async () => {
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([]));
    pushWhereResult([]);
    mockListVaultKeyCards.mockResolvedValue([
      { did: 'did:imajin:vaultkey3', purpose: 'unused', createdAt: '2026-01-01T00:00:00.000Z', timeline: [], grant: null, grants: [] },
    ]);

    const result = await listGrantsForOperator(OPERATOR_DID);
    expect(result.some((c) => c.source === 'vault-delegation')).toBe(false);
  });

  // #2298: a field can carry more than the mint-time grant once a second
  // consumer is granted access via `grantExistingMintedKey` — the Grants
  // lane must surface EVERY active consumer, not just the first.
  it('emits one vault-delegation card per active consumer grant, not just the mint-time one', async () => {
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([]));
    pushWhereResult([]);
    mockListVaultKeyCards.mockResolvedValue([
      {
        did: 'did:imajin:vaultkey4',
        purpose: 'signing key',
        createdAt: '2026-01-01T00:00:00.000Z',
        timeline: [],
        grant: {
          grantId: 'vdg_original',
          grantedTo: 'did:imajin:original-consumer',
          purpose: 'gha-runner',
          status: 'active',
          expiresAt: null,
          consumedAt: null,
          lastFetchedAt: null,
          ackedAt: null,
          ackOutcome: null,
          ackEvidence: null,
          createdAt: '2026-01-01T00:05:00.000Z',
        },
        grants: [
          {
            grantId: 'vdg_original',
            grantedTo: 'did:imajin:original-consumer',
            purpose: 'gha-runner',
            status: 'active',
            expiresAt: null,
            consumedAt: null,
            lastFetchedAt: null,
            ackedAt: null,
            ackOutcome: null,
            ackEvidence: null,
            createdAt: '2026-01-01T00:05:00.000Z',
          },
          {
            grantId: 'vdg_second',
            grantedTo: 'did:imajin:second-consumer',
            purpose: 'runtime-fetch',
            status: 'active',
            expiresAt: null,
            consumedAt: null,
            lastFetchedAt: null,
            ackedAt: null,
            ackOutcome: null,
            ackEvidence: { kind: 'gha-runner', ref: 'gx10' },
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    ]);

    const result = await listGrantsForOperator(OPERATOR_DID);
    const vaultCards = result.filter((c) => c.source === 'vault-delegation');

    expect(vaultCards).toHaveLength(2);
    expect(vaultCards.map((c) => c.id).sort()).toEqual(['vault-delegation:vdg_original', 'vault-delegation:vdg_second']);

    const secondConsumerCard = vaultCards.find((c) => c.id === 'vault-delegation:vdg_second')!;
    expect(secondConsumerCard).toMatchObject({
      grantee: 'did:imajin:second-consumer',
      capabilities: ['runtime-fetch'],
      issuedAt: '2026-01-02T00:00:00.000Z',
      ackEvidence: { kind: 'gha-runner', ref: 'gx10' },
      revoke: { method: 'POST', path: '/api/vault/delegation/revoke', body: { field: 'vault-minted-key:did:imajin:vaultkey4' } },
    });
  });

  it('does not double-count the mint-time grant when it is also present in the active-consumers list', async () => {
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([]));
    pushWhereResult([]);
    const sharedGrant = {
      grantId: 'vdg_shared',
      grantedTo: 'did:imajin:consumer1',
      purpose: 'gha-runner',
      status: 'active',
      expiresAt: null,
      consumedAt: null,
      lastFetchedAt: null,
      ackedAt: null,
      ackOutcome: null,
      ackEvidence: null,
      createdAt: '2026-01-01T00:05:00.000Z',
    };
    mockListVaultKeyCards.mockResolvedValue([
      {
        did: 'did:imajin:vaultkey5',
        purpose: 'signing key',
        createdAt: '2026-01-01T00:00:00.000Z',
        timeline: [],
        grant: sharedGrant,
        grants: [sharedGrant],
      },
    ]);

    const result = await listGrantsForOperator(OPERATOR_DID);
    expect(result.filter((c) => c.source === 'vault-delegation')).toHaveLength(1);
  });

  it('marks a revoked auth grant as non-revocable with no revoke action', async () => {
    mockListGrantDetailsForDelegator.mockResolvedValue([
      {
        grantId: 'grant_revoked',
        agentDid: 'did:imajin:agent2',
        capabilities: [{ capability: 'messages:write', status: 'revoked', revokedAt: '2026-01-01T00:00:00.000Z' }],
        issuedAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
        status: 'revoked',
      },
    ]);
    mockInnerJoinWhere.mockReturnValueOnce(Promise.resolve([]));
    pushWhereResult([]);

    const result = await listGrantsForOperator(OPERATOR_DID);
    const card = result.find((c) => c.source === 'auth-grant')!;
    expect(card.revocable).toBe(false);
    expect(card.revoke).toBeNull();
    expect(card.capabilities).toEqual(['(no active capabilities)']);
  });
});
