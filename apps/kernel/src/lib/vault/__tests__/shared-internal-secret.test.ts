/**
 * Unit tests for `grantInternalSecretTo` (#2245 — second target of the
 * #2241 epic, ATTESTATION_INTERNAL_API_KEY).
 *
 * Covers: Tier 1 rejection, self-provisioning the secret on the very first
 * grant, reusing an existing active grant's wrapped key material for a NEW
 * external `grantedTo` without re-sealing, skipping an erased source row,
 * and idempotency (calling twice for the same (purpose, granteeDid) reuses
 * the same grant rather than minting a duplicate).
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

const {
  grantStore,
  mockIsVaultTier1,
  mockGetNodeSigningIdentity,
  mockSignSync,
  mockCanonicalizeGrantPayload,
  mockGenerateId,
  mockGetInternalSecret,
  mockEmitGrantEvents,
} = vi.hoisted(() => ({
  grantStore: new Map<string, GrantRow>(),
  mockIsVaultTier1: vi.fn().mockReturnValue(false),
  mockGetNodeSigningIdentity: vi.fn().mockReturnValue({
    senderDid: 'did:imajin:node',
    senderPubkey: 'node-pubkey',
    privateKeyHex: 'node-priv',
  }),
  mockSignSync: vi.fn().mockReturnValue('signed'),
  mockCanonicalizeGrantPayload: vi.fn().mockReturnValue('canonical'),
  mockGenerateId: vi.fn((prefix: string) => `${prefix}_new`),
  mockGetInternalSecret: vi.fn().mockResolvedValue('the-secret-value'),
  mockEmitGrantEvents: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  crypto: { signSync: mockSignSync },
}));

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

vi.mock('../internal-secret', () => ({
  getInternalSecret: mockGetInternalSecret,
  internalSecretField: (purpose: string) => `internal-secret:${purpose}`,
}));

vi.mock('../grant', () => ({
  emitGrantEvents: mockEmitGrantEvents,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, value: unknown) => ({ __col: col, __eq: value }),
  and: (...clauses: unknown[]) => ({ __and: clauses }),
  desc: (_col: unknown) => ({ __desc: true }),
}));

function matchesClause(row: GrantRow, clause: unknown): boolean {
  const c = clause as { __and?: unknown[]; __eq?: unknown; __col?: { field: string } };
  if (c.__and) return c.__and.every((sub) => matchesClause(row, sub));
  if ('__eq' in c) {
    const field = c.__col?.field;
    if (field === 'subject') return row.subject === c.__eq;
    if (field === 'grantedTo') return row.grantedTo === c.__eq;
    if (field === 'status') return row.status === c.__eq;
    if (field === 'field') return row.field === c.__eq;
  }
  return true;
}

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = {
    id: { field: 'id' },
    subject: { field: 'subject' },
    field: { field: 'field' },
    grantedTo: { field: 'grantedTo' },
    status: { field: 'status' },
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: (clause: unknown) => ({
            limit: (n: number) =>
              Promise.resolve([...grantStore.values()].filter((row) => matchesClause(row, clause)).slice(0, n)),
            orderBy: () =>
              Promise.resolve(
                [...grantStore.values()]
                  .filter((row) => matchesClause(row, clause))
                  .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
              ),
          }),
        }),
      }),
      insert: () => ({
        values: (data: GrantRow) => {
          grantStore.set(data.id, data);
          return Promise.resolve([]);
        },
      }),
    },
    vaultDelegationGrants,
  };
});

import { grantInternalSecretTo } from '../shared-internal-secret';

const PURPOSE = 'kernel.attestation-internal-api-key';
const FIELD = `internal-secret:${PURPOSE}`;
const OWNER_DID = 'did:imajin:node';
const CORPUS_BOOTSTRAP_DID = 'did:imajin:corpus-bootstrap';

function activeSelfGrantRow(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'vdg_self',
    subject: OWNER_DID,
    grantedTo: OWNER_DID,
    field: FIELD,
    ownerXPub: 'owner-x-pub',
    wrappedKey: 'wrapped-key-bytes',
    wrappedNonce: 'wrapped-nonce-bytes',
    keyId: 'key-id-1',
    ownerSignature: 'sig',
    status: 'active',
    recipientXPub: 'node-x-pub',
    ownerEdPub: 'node-pubkey',
    purpose: PURPOSE,
    oneTime: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  grantStore.clear();
  mockIsVaultTier1.mockReturnValue(false);
  mockGetNodeSigningIdentity.mockReturnValue({
    senderDid: OWNER_DID,
    senderPubkey: 'node-pubkey',
    privateKeyHex: 'node-priv',
  });
  mockSignSync.mockReturnValue('signed');
  mockCanonicalizeGrantPayload.mockReturnValue('canonical');
  mockGenerateId.mockImplementation((prefix: string) => `${prefix}_new`);
  mockGetInternalSecret.mockResolvedValue('the-secret-value');

  grantStore.set('vdg_self', activeSelfGrantRow());
});

describe('grantInternalSecretTo', () => {
  it('rejects under Tier 1 (no external-owner countersign support yet)', async () => {
    mockIsVaultTier1.mockReturnValue(true);

    const outcome = await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');

    expect(outcome.status).toBe('tier1_unsupported');
    expect(mockGetInternalSecret).not.toHaveBeenCalled();
  });

  it('self-provisions the secret first (via getInternalSecret) before reusing its grant material', async () => {
    await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');
    expect(mockGetInternalSecret).toHaveBeenCalledWith(PURPOSE);
  });

  it('grants an additional consumer by reusing the self-grant\u2019s wrapped key material, without re-sealing', async () => {
    const outcome = await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');

    expect(outcome).toEqual({ status: 'ok', grantId: 'vdg_new' });
    const newRow = grantStore.get('vdg_new');
    expect(newRow).toMatchObject({
      subject: OWNER_DID,
      grantedTo: CORPUS_BOOTSTRAP_DID,
      field: FIELD,
      wrappedKey: 'wrapped-key-bytes',
      wrappedNonce: 'wrapped-nonce-bytes',
      ownerXPub: 'owner-x-pub',
      keyId: 'key-id-1',
      status: 'active',
      oneTime: false,
      purpose: PURPOSE,
    });
    // Never mutates or removes the original self-grant.
    expect(grantStore.get('vdg_self')?.status).toBe('active');
    expect(mockEmitGrantEvents).toHaveBeenCalledWith({
      grantId: 'vdg_new',
      did: OWNER_DID,
      field: FIELD,
      grantedTo: CORPUS_BOOTSTRAP_DID,
      grantedBy: 'did:imajin:operator',
    });
  });

  it('is idempotent \u2014 a second call for the same (purpose, granteeDid) reuses the existing active grant rather than minting a duplicate', async () => {
    const first = await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');
    const sizeAfterFirst = grantStore.size;

    const second = await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');

    expect(second).toEqual(first);
    expect(grantStore.size).toBe(sizeAfterFirst);
    // Only the first call actually granted anything — the second is a no-op re-run.
    expect(mockEmitGrantEvents).toHaveBeenCalledTimes(1);
  });

  it('returns no_reusable_grant when every existing row for the field has been erased (revoked/superseded)', async () => {
    grantStore.set('vdg_self', activeSelfGrantRow({ wrappedKey: '', wrappedNonce: '' }));

    const outcome = await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');

    expect(outcome).toEqual({ status: 'no_reusable_grant' });
  });

  it('skips an erased row and reuses an older intact one for the same field', async () => {
    grantStore.set('vdg_erased', {
      ...activeSelfGrantRow({ id: 'vdg_erased', wrappedKey: '', wrappedNonce: '', status: 'superseded' }),
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const outcome = await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');

    expect(outcome.status).toBe('ok');
    const newRow = outcome.status === 'ok' ? grantStore.get(outcome.grantId) : undefined;
    expect(newRow?.wrappedKey).toBe('wrapped-key-bytes');
  });

  it('never reuses — nor treats as already-granted — a row for the same field whose subject is NOT this node’s own DID', async () => {
    const OTHER_NODE_DID = 'did:imajin:some-other-node';
    // Same field name, active, intact key material, and even already granted
    // to the SAME grantee — but sealed by a DIFFERENT node (subject). Reusing
    // this row's wrappedKey would be wrong: the no-re-seal argument only
    // holds because the wrap is to THIS node's own X25519 key.
    grantStore.set('vdg_foreign', activeSelfGrantRow({
      id: 'vdg_foreign',
      subject: OTHER_NODE_DID,
      grantedTo: CORPUS_BOOTSTRAP_DID,
      wrappedKey: 'foreign-wrapped-key',
      wrappedNonce: 'foreign-wrapped-nonce',
    }));

    const outcome = await grantInternalSecretTo(PURPOSE, CORPUS_BOOTSTRAP_DID, 'did:imajin:operator');

    // Must still mint a fresh grant sourced from THIS node's own self-grant
    // (vdg_self), never reusing or short-circuiting on the foreign row.
    expect(outcome).toEqual({ status: 'ok', grantId: 'vdg_new' });
    const newRow = grantStore.get('vdg_new');
    expect(newRow).toMatchObject({
      subject: OWNER_DID,
      wrappedKey: 'wrapped-key-bytes',
      wrappedNonce: 'wrapped-nonce-bytes',
    });
  });
});
