/**
 * Unit tests for `listVaultKeyCards` / `listHandProvisionedFields` (#2247).
 *
 * Covers: timeline row construction (minted/granted/fetched/acked/revoked),
 * the fetch-without-ack "red line" flag, the "held in memory by" status
 * fields, and the hand-provisioned filter's field-name-prefix heuristic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MintedKeyRow {
  id: string;
  did: string;
  publicKey: string;
  field: string;
  purpose: string;
  requestedBy: string;
  mintedBy: string;
  grantId: string | null;
  status: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
}

interface GrantRow {
  id: string;
  grantedTo: string;
  purpose: string | null;
  oneTime: boolean;
  status: string;
  expiresAt: Date | null;
  consumedAt: Date | null;
  lastFetchedAt: Date | null;
  ackedAt: Date | null;
  ackOutcome: string | null;
  ackEvidence: Record<string, unknown> | null;
  createdAt: Date;
}

const { mintedKeyStore, grantStore, mockVaultServiceList } = vi.hoisted(() => ({
  mintedKeyStore: new Map<string, MintedKeyRow>(),
  grantStore: new Map<string, GrantRow>(),
  mockVaultServiceList: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, value: unknown) => ({ __eq: value }),
  desc: (_col: unknown) => ({ __desc: true }),
  inArray: (_col: unknown, values: unknown[]) => ({ __inArray: values }),
}));

vi.mock('@/src/db', () => {
  const vaultMintedKeys = { __table: 'minted-keys' };
  const vaultDelegationGrants = { __table: 'grants' };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          orderBy: () => Promise.resolve(
            [...mintedKeyStore.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
          ),
          where: (clause: { __inArray?: string[]; __eq?: string }) => {
            if (table === vaultDelegationGrants) {
              const ids = clause?.__inArray ?? [];
              return Promise.resolve([...grantStore.values()].filter((g) => ids.includes(g.id)));
            }
            return {
              limit: () => Promise.resolve(
                [...mintedKeyStore.values()].filter((k) => k.did === clause?.__eq),
              ),
            };
          },
        }),
      }),
    },
    vaultMintedKeys,
    vaultDelegationGrants,
  };
});

vi.mock('../index', () => ({
  vaultService: { list: mockVaultServiceList },
}));

// key-cards.ts only needs the pure field-name formula from mint.ts —
// mocked here so this test file never pulls in mint.ts's own
// @imajin/auth/@imajin/bus dependency graph.
vi.mock('../mint', () => ({
  mintedKeyField: (did: string) => `vault-minted-key:${did}`,
}));

import { listVaultKeyCards, listHandProvisionedFields, getMintedKeyByDid } from '../key-cards.js';

const MINTED_DID = 'did:imajin:abcdef0123456789';
const FIELD = `vault-minted-key:${MINTED_DID}`;

function mintedRow(overrides: Partial<MintedKeyRow> = {}): MintedKeyRow {
  return {
    id: 'vmk_1',
    did: MINTED_DID,
    publicKey: 'a'.repeat(64),
    field: FIELD,
    purpose: 'corpus-identity',
    requestedBy: 'did:imajin:corpus-bootstrap',
    mintedBy: 'did:imajin:node',
    grantId: 'vdg_1',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

function grantRow(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'vdg_1',
    grantedTo: 'did:imajin:corpus-bootstrap',
    purpose: 'corpus-identity',
    oneTime: true,
    status: 'active',
    expiresAt: null,
    consumedAt: null,
    lastFetchedAt: null,
    ackedAt: null,
    ackOutcome: null,
    ackEvidence: null,
    createdAt: new Date('2026-01-01T00:05:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mintedKeyStore.clear();
  grantStore.clear();
});

describe('listVaultKeyCards', () => {
  it('always includes a minted row as the first timeline event', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow({ grantId: null }));

    const [card] = await listVaultKeyCards();

    expect(card.timeline[0]).toMatchObject({ type: 'minted', detail: { by: 'did:imajin:node', purpose: 'corpus-identity' } });
    expect(card.grant).toBeNull();
  });

  it('adds a granted row when a grant exists', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow());
    grantStore.set('vdg_1', grantRow());

    const [card] = await listVaultKeyCards();

    const granted = card.timeline.find((e) => e.type === 'granted');
    expect(granted).toBeDefined();
    expect(granted?.detail.to).toBe('did:imajin:corpus-bootstrap');
  });

  it('renders a fetched row with alert=true when fetched but never acked (the red line)', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow());
    grantStore.set('vdg_1', grantRow({ lastFetchedAt: new Date('2026-01-01T01:00:00.000Z'), ackedAt: null }));

    const [card] = await listVaultKeyCards();

    const fetched = card.timeline.find((e) => e.type === 'fetched');
    expect(fetched?.alert).toBe(true);
    expect(card.fetchWithoutAck).toBe(true);
  });

  it('renders a fetched row with alert=false and an acked row when the grant was acked', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow());
    grantStore.set('vdg_1', grantRow({
      lastFetchedAt: new Date('2026-01-01T01:00:00.000Z'),
      ackedAt: new Date('2026-01-01T01:05:00.000Z'),
      ackOutcome: 'used',
    }));

    const [card] = await listVaultKeyCards();

    const fetched = card.timeline.find((e) => e.type === 'fetched');
    const acked = card.timeline.find((e) => e.type === 'acked');
    expect(fetched?.alert).toBe(false);
    expect(acked?.detail.outcome).toBe('used');
    expect(card.fetchWithoutAck).toBe(false);
  });

  it('sets heldBy/lastAckAt for the "held in memory by X, last ack Nm ago" status line', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow());
    grantStore.set('vdg_1', grantRow({
      lastFetchedAt: new Date('2026-01-01T01:00:00.000Z'),
      ackedAt: new Date('2026-01-01T01:05:00.000Z'),
    }));

    const [card] = await listVaultKeyCards();

    expect(card.heldBy).toBe('did:imajin:corpus-bootstrap');
    expect(card.lastAckAt).toBe('2026-01-01T01:05:00.000Z');
  });

  it('leaves heldBy null when the grant has never been fetched', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow());
    grantStore.set('vdg_1', grantRow());

    const [card] = await listVaultKeyCards();

    expect(card.heldBy).toBeNull();
  });

  it('adds a revoked row for a tombstoned key', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow({
      status: 'revoked',
      revokedAt: new Date('2026-01-02T00:00:00.000Z'),
      revokedBy: 'did:imajin:operator',
    }));
    grantStore.set('vdg_1', grantRow());

    const [card] = await listVaultKeyCards();

    const revoked = card.timeline.find((e) => e.type === 'revoked');
    expect(revoked).toBeDefined();
    expect(revoked?.detail.by).toBe('did:imajin:operator');
    expect(card.status).toBe('revoked');
  });

  it('returns an empty timeline extra rows for a key with no grant at all (pending Tier 1 owner agent)', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow({ grantId: null }));

    const [card] = await listVaultKeyCards();

    expect(card.timeline).toHaveLength(1);
    expect(card.grant).toBeNull();
  });
});

describe('listHandProvisionedFields', () => {
  it('excludes fields shaped like a mint-in-vault field name', async () => {
    mockVaultServiceList.mockResolvedValue([
      { field: FIELD, senderDid: 'did:imajin:node', timestamp: '2026-01-01T00:00:00.000Z', custodyScheme: 'delegation-grant', deleted: false },
      { field: 'GH_TOKEN:did:imajin:owner', senderDid: 'did:imajin:node', timestamp: '2025-06-01T00:00:00.000Z', custodyScheme: 'node-sealed', deleted: false },
    ]);

    const result = await listHandProvisionedFields();

    expect(result).toHaveLength(1);
    expect(result[0]?.field).toBe('GH_TOKEN:did:imajin:owner');
  });

  it('marks a tombstoned entry as deleted', async () => {
    mockVaultServiceList.mockResolvedValue([
      { field: 'GH_TOKEN:did:imajin:owner', senderDid: 'did:imajin:node', timestamp: '2025-06-01T00:00:00.000Z', custodyScheme: 'node-sealed', deleted: true },
    ]);

    const [entry] = await listHandProvisionedFields();

    expect(entry?.status).toBe('deleted');
  });
});

describe('getMintedKeyByDid', () => {
  it('returns the row for a known DID', async () => {
    mintedKeyStore.set(MINTED_DID, mintedRow());

    const row = await getMintedKeyByDid(MINTED_DID);

    expect(row?.did).toBe(MINTED_DID);
  });

  it('returns undefined for an unknown DID', async () => {
    const row = await getMintedKeyByDid('did:imajin:does-not-exist');

    expect(row).toBeUndefined();
  });
});
