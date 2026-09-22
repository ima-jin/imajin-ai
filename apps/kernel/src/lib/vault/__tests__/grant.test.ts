/**
 * Unit tests for `grantExistingMintedKey` / `emitGrantEvents` (#2247).
 *
 * Covers: Tier 1 rejection, not-found/revoked minted keys, reusing an
 * existing grant's wrapped key material for a NEW grantedTo without
 * re-sealing, skipping an erased (revoked/superseded) source row, and the
 * emitted bus event shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface GrantRow {
  id: string;
  subject: string;
  grantedTo: string;
  field: string;
  ownerXPub: string;
  wrappedKey: string;
  wrappedNonce: string;
  keyId: string;
  ownerSignature: string;
  status: string;
  recipientXPub: string;
  ownerEdPub: string | null;
  purpose: string | null;
  oneTime: boolean;
  createdAt: Date;
}

interface MintedKeyRow {
  id: string;
  did: string;
  field: string;
  status: string;
}

const {
  mintedKeyStore,
  grantStore,
  mockIsVaultTier1,
  mockGetNodeSigningIdentity,
  mockSignSync,
  mockCanonicalizeGrantPayload,
  mockPublish,
  mockGenerateId,
} = vi.hoisted(() => ({
  mintedKeyStore: new Map<string, MintedKeyRow>(),
  grantStore: new Map<string, GrantRow>(),
  mockIsVaultTier1: vi.fn().mockReturnValue(false),
  mockGetNodeSigningIdentity: vi.fn().mockReturnValue({
    senderDid: 'did:imajin:node',
    senderPubkey: 'node-pubkey',
    privateKeyHex: 'node-priv',
  }),
  mockSignSync: vi.fn().mockReturnValue('signed'),
  mockCanonicalizeGrantPayload: vi.fn().mockReturnValue('canonical'),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockGenerateId: vi.fn((prefix: string) => `${prefix}_new`),
}));

vi.mock('@imajin/auth', () => ({
  crypto: { signSync: mockSignSync },
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: mockGenerateId,
}));

vi.mock('../sealing', () => ({
  getNodeSigningIdentity: mockGetNodeSigningIdentity,
  isVaultTier1: mockIsVaultTier1,
}));

vi.mock('../index', () => ({
  canonicalizeGrantPayload: mockCanonicalizeGrantPayload,
}));

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, value: unknown) => ({ __eq: value }),
  desc: (_col: unknown) => ({ __desc: true }),
}));

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = { __table: 'grants' };
  const vaultMintedKeys = { __table: 'minted-keys' };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (clause: { __eq?: string }) => ({
            limit: () => {
              if (table === vaultMintedKeys) {
                return Promise.resolve([...mintedKeyStore.values()].filter((k) => k.did === clause?.__eq));
              }
              return Promise.resolve([]);
            },
            orderBy: () => Promise.resolve(
              [...grantStore.values()]
                .filter((g) => g.field === clause?.__eq)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
            ),
          }),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (data: GrantRow) => {
          grantStore.set(data.id, data);
          return Promise.resolve([]);
        },
      }),
    },
    vaultDelegationGrants,
    vaultMintedKeys,
  };
});

import { grantExistingMintedKey, emitGrantEvents } from '../grant.js';

const MINTED_DID = 'did:imajin:abcdef0123456789';
const FIELD = `vault-minted-key:${MINTED_DID}`;

function activeGrantRow(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'vdg_original',
    subject: MINTED_DID,
    grantedTo: 'did:imajin:corpus-bootstrap',
    field: FIELD,
    ownerXPub: 'owner-x-pub',
    wrappedKey: 'wrapped-key-bytes',
    wrappedNonce: 'wrapped-nonce-bytes',
    keyId: 'key-id-1',
    ownerSignature: 'sig',
    status: 'active',
    recipientXPub: 'node-x-pub',
    ownerEdPub: 'node-pubkey',
    purpose: 'corpus-identity',
    oneTime: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mintedKeyStore.clear();
  grantStore.clear();
  mockIsVaultTier1.mockReturnValue(false);
  mockGetNodeSigningIdentity.mockReturnValue({
    senderDid: 'did:imajin:node',
    senderPubkey: 'node-pubkey',
    privateKeyHex: 'node-priv',
  });
  mockSignSync.mockReturnValue('signed');
  mockCanonicalizeGrantPayload.mockReturnValue('canonical');
  mockGenerateId.mockImplementation((prefix: string) => `${prefix}_new`);

  mintedKeyStore.set(MINTED_DID, { id: 'vmk_1', did: MINTED_DID, field: FIELD, status: 'active' });
  grantStore.set('vdg_original', activeGrantRow());
});

describe('grantExistingMintedKey', () => {
  it('rejects under Tier 1 (no external-owner countersign support yet)', async () => {
    mockIsVaultTier1.mockReturnValue(true);

    const outcome = await grantExistingMintedKey({
      did: MINTED_DID,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    });

    expect(outcome.status).toBe('tier1_unsupported');
  });

  it('returns not_found for an unknown DID', async () => {
    const outcome = await grantExistingMintedKey({
      did: 'did:imajin:does-not-exist',
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    });

    expect(outcome.status).toBe('not_found');
  });

  it('returns revoked when the minted key has already been revoked', async () => {
    mintedKeyStore.set(MINTED_DID, { id: 'vmk_1', did: MINTED_DID, field: FIELD, status: 'revoked' });

    const outcome = await grantExistingMintedKey({
      did: MINTED_DID,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    });

    expect(outcome.status).toBe('revoked');
  });

  it('returns no_reusable_grant when every grant row for the field has erased key material', async () => {
    grantStore.set('vdg_original', activeGrantRow({ wrappedKey: '', wrappedNonce: '' }));

    const outcome = await grantExistingMintedKey({
      did: MINTED_DID,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    });

    expect(outcome.status).toBe('no_reusable_grant');
  });

  it('inserts a new grant row reusing the existing wrapped key material for a NEW grantedTo, without re-sealing', async () => {
    const outcome = await grantExistingMintedKey({
      did: MINTED_DID,
      grantedTo: 'did:imajin:prod-corpus',
      purpose: 'runtime-fetch',
      oneTime: true,
      grantedBy: 'did:imajin:operator',
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    const inserted = grantStore.get(outcome.grantId);
    expect(inserted).toBeDefined();
    expect(inserted?.grantedTo).toBe('did:imajin:prod-corpus');
    expect(inserted?.wrappedKey).toBe('wrapped-key-bytes');
    expect(inserted?.wrappedNonce).toBe('wrapped-nonce-bytes');
    expect(inserted?.ownerXPub).toBe('owner-x-pub');
    expect(inserted?.keyId).toBe('key-id-1');
    expect(inserted?.status).toBe('active');
    expect(inserted?.purpose).toBe('runtime-fetch');
    expect(inserted?.oneTime).toBe(true);
  });

  it('signs the new grant payload with the node identity', async () => {
    await grantExistingMintedKey({
      did: MINTED_DID,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    });

    expect(mockSignSync).toHaveBeenCalledWith('canonical', 'node-priv');
  });
});

describe('emitGrantEvents', () => {
  it('publishes a vault.grant.fulfilled bus event with grantId/did/field/grantedTo', () => {
    emitGrantEvents({
      grantId: 'vdg_new',
      did: MINTED_DID,
      field: FIELD,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [eventType, event] = mockPublish.mock.calls[0]!;
    expect(eventType).toBe('vault.grant.fulfilled');
    expect(event.payload.grantId).toBe('vdg_new');
    expect(event.payload.field).toBe(FIELD);
    expect(event.payload.grantedTo).toBe('did:imajin:prod-corpus');
  });

  // #2247 signing-roles ruling: a canvas-approved grant carries the
  // countersigned decision's reference on the emitted event.
  it('includes authorizedBy on the bus event payload when supplied', () => {
    const authorizedBy = { approvalId: 'vprop_1', operatorDid: 'did:imajin:operator', contentHash: 'a'.repeat(64), decidedAt: '2026-01-01T00:00:00.000Z' };

    emitGrantEvents({
      grantId: 'vdg_new',
      did: MINTED_DID,
      field: FIELD,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:node',
      authorizedBy,
    });

    const [, event] = mockPublish.mock.calls[0]!;
    expect(event.payload.authorizedBy).toEqual(authorizedBy);
  });

  it('omits authorizedBy entirely when not supplied', () => {
    emitGrantEvents({
      grantId: 'vdg_new',
      did: MINTED_DID,
      field: FIELD,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    });

    const [, event] = mockPublish.mock.calls[0]!;
    expect(event.payload.authorizedBy).toBeUndefined();
  });

  it('never throws when the bus publish itself rejects', () => {
    mockPublish.mockRejectedValue(new Error('bus unavailable'));

    expect(() => emitGrantEvents({
      grantId: 'vdg_new',
      did: MINTED_DID,
      field: FIELD,
      grantedTo: 'did:imajin:prod-corpus',
      grantedBy: 'did:imajin:operator',
    })).not.toThrow();
  });
});
