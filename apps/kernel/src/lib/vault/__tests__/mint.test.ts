/**
 * Unit tests for `mintKeypair` / `revokeMintedKey` (#2242).
 *
 * `sealAndGrantStaticSecret` / `revokeStaticSecretGrant` (the underlying
 * vault crypto + custody primitives) already have exhaustive coverage in
 * static-secret-grant.test.ts — these tests mock that boundary and focus
 * purely on mint.ts's own orchestration: keypair generation never leaking
 * the private key, the vault_minted_keys bookkeeping row, and the
 * soft-tombstone revoke contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type MintedKeyRow = Record<string, unknown> & {
  id: string;
  did: string;
  publicKey: string;
  field: string;
  purpose: string;
  requestedBy: string;
  mintedBy: string;
  grantId: string | null;
  status: string;
  revokedAt: Date | null;
  revokedBy: string | null;
};

const {
  mintedKeyStore,
  mockGenerateKeypair,
  mockSealAndGrantStaticSecret,
  mockRevokeStaticSecretGrant,
  mockEmitAttestation,
  mockPublish,
} = vi.hoisted(() => ({
  mintedKeyStore: new Map<string, MintedKeyRow>(),
  mockGenerateKeypair: vi.fn(),
  mockSealAndGrantStaticSecret: vi.fn(),
  mockRevokeStaticSecretGrant: vi.fn(),
  mockEmitAttestation: vi.fn().mockResolvedValue({}),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/auth', () => ({
  generateKeypair: mockGenerateKeypair,
  emitAttestation: mockEmitAttestation,
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_test`,
}));

vi.mock('../index', () => ({
  sealAndGrantStaticSecret: mockSealAndGrantStaticSecret,
  revokeStaticSecretGrant: mockRevokeStaticSecretGrant,
}));

vi.mock('@/src/db', () => {
  const vaultMintedKeys = { __table: 'minted-keys' };
  return {
    db: {
      insert: (_table: unknown) => ({
        values: (data: MintedKeyRow) => {
          mintedKeyStore.set(data.id, data);
          return Promise.resolve([]);
        },
      }),
      select: () => ({
        from: (_table: unknown) => ({
          where: () => ({
            limit: () => {
              // eq(vaultMintedKeys.did, did) — evaluated by the caller passing
              // an object we can't introspect through this stub, so instead
              // the test-facing helper below filters directly.
              return Promise.resolve([...mintedKeyStore.values()]);
            },
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (patch: Partial<MintedKeyRow>) => ({
          where: () => ({
            returning: () => {
              // Only one row is ever updated in these tests (by id).
              const [row] = [...mintedKeyStore.values()];
              if (!row) return Promise.resolve([]);
              const updated = { ...row, ...patch } as MintedKeyRow;
              mintedKeyStore.set(row.id, updated);
              return Promise.resolve([updated]);
            },
          }),
        }),
      }),
    },
    vaultMintedKeys,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, value: unknown) => ({ __eq: value }),
}));

import { mintKeypair, revokeMintedKey, mintedKeyField, emitMintedEvents, emitRevokedEvents } from '../mint.js';

const PUBLIC_KEY = 'a'.repeat(64);
const PRIVATE_KEY = 'b'.repeat(64);
const EXPECTED_DID = `did:imajin:${PUBLIC_KEY.slice(0, 16)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mintedKeyStore.clear();
  mockGenerateKeypair.mockReturnValue({ privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY });
  mockSealAndGrantStaticSecret.mockResolvedValue({ entry: {}, grantId: 'vdg_test', requestId: null });
  mockRevokeStaticSecretGrant.mockResolvedValue(true);
});

// The select mock above returns everything in the store rather than
// filtering by `did`, so tests that need "not found" semantics clear the
// store first — matching what a real WHERE eq(did, ...) with no matching
// row returns.

describe('mintKeypair', () => {
  it('derives the DID from the generated public key', async () => {
    const result = await mintKeypair({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: 'did:imajin:node',
    });

    expect(result.did).toBe(EXPECTED_DID);
    expect(result.publicKey).toBe(PUBLIC_KEY);
    expect(result.field).toBe(mintedKeyField(EXPECTED_DID));
  });

  it('never returns the private key', async () => {
    const result = await mintKeypair({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: 'did:imajin:node',
    });

    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it('seals the private key as a one-time, purpose-bound grant to requesterDid', async () => {
    await mintKeypair({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: 'did:imajin:node',
    });

    expect(mockSealAndGrantStaticSecret).toHaveBeenCalledWith(
      mintedKeyField(EXPECTED_DID),
      PRIVATE_KEY,
      expect.objectContaining({
        principalDid: EXPECTED_DID,
        granteeDid: 'did:imajin:corpus-bootstrap',
        purpose: 'corpus-identity',
        oneTime: true,
      }),
    );
  });

  it('records a vault_minted_keys row with mintedBy distinct from requesterDid', async () => {
    await mintKeypair({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: 'did:imajin:node',
    });

    const [row] = [...mintedKeyStore.values()];
    expect(row?.did).toBe(EXPECTED_DID);
    expect(row?.requestedBy).toBe('did:imajin:corpus-bootstrap');
    expect(row?.mintedBy).toBe('did:imajin:node');
    expect(row?.status).toBe('active');
    expect(row?.grantId).toBe('vdg_test');
  });

  it('tolerates a null grantId under Tier 1 (pending owner-agent grant)', async () => {
    mockSealAndGrantStaticSecret.mockResolvedValue({ entry: {}, grantId: null, requestId: 'req_1' });

    const result = await mintKeypair({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: 'did:imajin:node',
    });

    expect(result.grantId).toBeNull();
    expect(result.requestId).toBe('req_1');
  });
});

describe('revokeMintedKey', () => {
  async function mintOne() {
    return mintKeypair({
      purpose: 'corpus-identity',
      requesterDid: 'did:imajin:corpus-bootstrap',
      mintedBy: 'did:imajin:node',
    });
  }

  it('returns not_found for an unknown DID', async () => {
    const outcome = await revokeMintedKey({ did: 'did:imajin:does-not-exist', revokedBy: 'did:imajin:node' });
    expect(outcome.status).toBe('not_found');
  });

  it('erases the delegation grant key material via revokeStaticSecretGrant', async () => {
    const minted = await mintOne();

    await revokeMintedKey({ did: minted.did, revokedBy: 'did:imajin:node' });

    expect(mockRevokeStaticSecretGrant).toHaveBeenCalledWith(minted.field, 'did:imajin:corpus-bootstrap');
  });

  it('tombstones the record: status revoked, revokedAt/revokedBy set, row still present', async () => {
    const minted = await mintOne();

    const outcome = await revokeMintedKey({ did: minted.did, revokedBy: 'did:imajin:node' });

    expect(outcome.status).toBe('revoked');
    if (outcome.status === 'revoked') {
      expect(outcome.record.status).toBe('revoked');
      expect(outcome.record.revokedBy).toBe('did:imajin:node');
      expect(outcome.record.revokedAt).toBeInstanceOf(Date);
      // The tombstone remembers the key existed — did/publicKey survive.
      expect(outcome.record.did).toBe(minted.did);
      expect(outcome.record.publicKey).toBe(minted.publicKey);
    }
  });

  it('is idempotent: revoking an already-revoked key returns already_revoked without re-erasing', async () => {
    const minted = await mintOne();
    await revokeMintedKey({ did: minted.did, revokedBy: 'did:imajin:node' });
    mockRevokeStaticSecretGrant.mockClear();

    const second = await revokeMintedKey({ did: minted.did, revokedBy: 'did:imajin:node' });

    expect(second.status).toBe('already_revoked');
    expect(mockRevokeStaticSecretGrant).not.toHaveBeenCalled();
  });
});

// #2247: emitMintedEvents/emitRevokedEvents are shared between
// `POST /api/vault/mint(/revoke)` and the vault-proposal execution bridge
// (`approvals-execution.ts`) — tested once here rather than duplicated at
// each call site.
describe('emitMintedEvents', () => {
  const minted = {
    mintId: 'vmk_test',
    did: EXPECTED_DID,
    publicKey: PUBLIC_KEY,
    field: mintedKeyField(EXPECTED_DID),
    grantId: 'vdg_test',
    requestId: null,
  };

  it('emits a vault.key.minted attestation with issuer = mintedBy, subject = minted DID, and no key material', () => {
    emitMintedEvents({ minted, purpose: 'corpus-identity', requesterDid: 'did:imajin:corpus-bootstrap', mintedBy: 'did:imajin:node' });

    expect(mockEmitAttestation).toHaveBeenCalledTimes(1);
    const [params] = mockEmitAttestation.mock.calls[0]!;
    expect(params.type).toBe('vault.key.minted');
    expect(params.issuer_did).toBe('did:imajin:node');
    expect(params.subject_did).toBe(EXPECTED_DID);
    expect(JSON.stringify(params)).not.toContain(PRIVATE_KEY);
  });

  it('publishes a vault.key.minted bus event with requestedBy/mintedBy and no key material', () => {
    emitMintedEvents({ minted, purpose: 'corpus-identity', requesterDid: 'did:imajin:corpus-bootstrap', mintedBy: 'did:imajin:node' });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [eventType, event] = mockPublish.mock.calls[0]!;
    expect(eventType).toBe('vault.key.minted');
    expect(event.payload.did).toBe(EXPECTED_DID);
    expect(event.payload.requestedBy).toBe('did:imajin:corpus-bootstrap');
    expect(event.payload.mintedBy).toBe('did:imajin:node');
    expect(JSON.stringify(event.payload)).not.toContain(PRIVATE_KEY);
  });

  it('never throws when the attestation or bus publish itself rejects', () => {
    mockEmitAttestation.mockRejectedValue(new Error('attestation service down'));
    mockPublish.mockRejectedValue(new Error('bus unavailable'));

    expect(() => emitMintedEvents({ minted, purpose: 'x', requesterDid: 'did:imajin:x', mintedBy: 'did:imajin:node' })).not.toThrow();
  });
});

describe('emitRevokedEvents', () => {
  const record = { id: 'vmk_test', did: EXPECTED_DID, publicKey: PUBLIC_KEY } as unknown as Parameters<typeof emitRevokedEvents>[0];

  it('emits a vault.key.revoked attestation with issuer/revokedBy and no key material', () => {
    emitRevokedEvents(record, 'did:imajin:node');

    expect(mockEmitAttestation).toHaveBeenCalledTimes(1);
    const [params] = mockEmitAttestation.mock.calls[0]!;
    expect(params.type).toBe('vault.key.revoked');
    expect(params.issuer_did).toBe('did:imajin:node');
    expect(params.subject_did).toBe(EXPECTED_DID);
    expect(JSON.stringify(params)).not.toContain(PRIVATE_KEY);
  });

  it('publishes a vault.key.revoked bus event', () => {
    emitRevokedEvents(record, 'did:imajin:node');

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [eventType, event] = mockPublish.mock.calls[0]!;
    expect(eventType).toBe('vault.key.revoked');
    expect(event.payload.did).toBe(EXPECTED_DID);
    expect(event.payload.revokedBy).toBe('did:imajin:node');
  });
});
