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
  },
  registryApps: { appDid: 'registryApps.appDid', name: 'registryApps.name' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
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
} from '../grants-lane';

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
      },
    ]);
    pushWhereResult([{ appDid: 'did:imajin:app1', name: 'Muse Code' }]);

    const result = await listAppAuthorizationsForOwner(OPERATOR_DID);

    expect(result).toEqual([
      {
        attestationId: 'att_1',
        appDid: 'did:imajin:app1',
        appName: 'Muse Code',
        scopes: ['supply:read'],
        authorizedAt: '2026-02-01T00:00:00.000Z',
        revokedAt: null,
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
});

describe('listGrantsForOperator', () => {
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
    expect(vaultCard).toMatchObject({
      id: 'vault-delegation:vdg_1',
      grantee: 'did:imajin:consumer1',
      capabilities: ['gha-runner'],
      issuedAt: '2026-01-02T00:00:00.000Z',
      ackState: null,
      revoke: { method: 'POST', path: '/api/vault/delegation/revoke', body: { field: 'vault-minted-key:did:imajin:vaultkey1' } },
    });

    const bearerCard = result.find((c) => c.source === 'access-bearer')!;
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
