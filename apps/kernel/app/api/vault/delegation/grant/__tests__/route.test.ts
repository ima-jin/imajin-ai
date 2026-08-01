/**
 * Unit tests for POST /api/vault/delegation/grant (#1521).
 *
 * This is the Tier 1 endpoint the external owner agent posts to. #1521 changed
 * three things about it, all covered here:
 *
 *   - Superseded grants now have their key material erased, so a replaced grant
 *     stops being a usable copy of the field key.
 *   - New grants record `recipientXPub`, taken from the stored request row rather
 *     than the request body — the body is attacker-shaped input, the row was
 *     written by this node at seal time.
 *   - New grants pin `ownerEdPub`, the verifier their signature was checked
 *     against, so they stay verifiable if the Tier 1 env later changes.
 *
 * The existing guards (pending request required, ownerXPub match, signature
 * validity, grantedTo binding) are asserted too, since the new code sits behind
 * them and a regression there would be severe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock: @/src/db ────────────────────────────────────────────────────────────

const { mockSelectLimit, mockInsertValues, mockUpdateReturning, mockUpdate } = vi.hoisted(() => {
  const mockSelectLimit = vi.fn<() => Promise<Array<Record<string, unknown>>>>();
  const mockInsertValues = vi.fn((_values: Record<string, unknown>) => Promise.resolve([]));
  const mockUpdateReturning = vi.fn<() => Promise<Array<Record<string, unknown>>>>();

  const mockUpdate = vi.fn(() => ({
    set: () => {
      const p = Promise.resolve([] as unknown[]);
      return {
        where: () => ({
          then: p.then.bind(p),
          catch: p.catch.bind(p),
          finally: p.finally.bind(p),
          returning: mockUpdateReturning,
        }),
      };
    },
  }));

  return { mockSelectLimit, mockInsertValues, mockUpdateReturning, mockUpdate };
});

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }),
    insert: () => ({ values: mockInsertValues }),
    update: mockUpdate,
  },
  vaultDelegationGrants: {},
  vaultGrantRequests: {},
}));

// ── Mock: auth ────────────────────────────────────────────────────────────────

const { mockRequireAdmin, mockVerifySync } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockVerifySync: vi.fn(() => true),
}));

vi.mock('@imajin/auth', () => ({
  requireAdmin: mockRequireAdmin,
  verifySync: mockVerifySync,
}));

// ── Mock: vault lib, sealing, id, bus, logger ─────────────────────────────────

const { mockErase, mockPeek, mockGetOwnerEnvelope } = vi.hoisted(() => ({
  mockErase: vi.fn(async (grants: Array<{ id: string }>) => grants.map((g) => g.id)),
  mockPeek: vi.fn<() => Promise<Record<string, unknown> | undefined>>(),
  mockGetOwnerEnvelope: vi.fn<() => Promise<Record<string, unknown> | undefined>>(),
}));

vi.mock('@/src/lib/vault', () => ({
  canonicalizeGrantPayload: () => 'canonical',
  eraseInactiveGrantKeyMaterial: mockErase,
  expectedGrantVerifier: () => OWNER_ED_PUB,
  getOwnerEnvelope: mockGetOwnerEnvelope,
  vaultService: { peek: mockPeek },
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({
    senderDid: NODE_DID,
    senderPubkey: 'a'.repeat(64),
    privateKeyHex: 'b'.repeat(64),
  }),
  getExternalOwnerEdPublicKey: () => OWNER_ED_PUB,
  getNodeXPublicKey: () => NODE_X_PUB,
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (p: string) => `${p}_new` }));

vi.mock('@imajin/bus', () => ({ publish: vi.fn(() => Promise.resolve()) }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { POST } from '../route.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_DID = 'did:imajin:testnode';
const OWNER_DID = 'did:imajin:owner';
const OWNER_ED_PUB = 'e'.repeat(64);
const OWNER_X_PUB = 'f'.repeat(64);
const NODE_X_PUB = '9'.repeat(64);
/**
 * Deliberately different from {@link NODE_X_PUB}. In production both are the
 * node's X25519 pubkey, but keeping them distinct here is what lets the tests
 * tell apart "read from the seal-time request row" from "derived just now".
 */
const REQUEST_ROW_X_PUB = '8'.repeat(64);

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    subject: OWNER_DID,
    grantedTo: NODE_DID,
    field: 'GH_TOKEN',
    ownerXPub: OWNER_X_PUB,
    wrappedKey: 'WRAPPED',
    wrappedNonce: 'NONCE',
    keyId: 'kid:test',
    ownerSignature: 'c'.repeat(128),
    expiresAt: null,
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/vault/delegation/grant', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** The pending request row this node wrote at seal time. */
function pendingRequestRow() {
  return { requestId: 'req-1', ownerXPub: OWNER_X_PUB, nodeXPub: REQUEST_ROW_X_PUB, status: 'pending' };
}

/** The v2 entry a renewal grants against. */
function sealedEntry(overrides: Record<string, unknown> = {}) {
  return {
    field: 'GH_TOKEN',
    keyId: 'kid:test',
    custodyScheme: 'delegation-grant',
    senderPubkey: 'a'.repeat(64),
    ...overrides,
  };
}

/** The owner's durable copy of the field key (#1521). */
function ownerEnvelopeRow(overrides: Record<string, unknown> = {}) {
  return { field: 'GH_TOKEN', keyId: 'kid:test', ownerXPub: OWNER_X_PUB, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockVerifySync.mockReturnValue(true);
  mockSelectLimit.mockResolvedValue([pendingRequestRow()]);
  mockUpdateReturning.mockResolvedValue([]);
  mockErase.mockImplementation(async (grants: Array<{ id: string }>) => grants.map((g) => g.id));
  mockPeek.mockResolvedValue(sealedEntry());
  mockGetOwnerEnvelope.mockResolvedValue(ownerEnvelopeRow());
});

// ── Guards ────────────────────────────────────────────────────────────────────

describe('POST /api/vault/delegation/grant — guards', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    expect((await POST(makeRequest(validBody()) as never)).status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    expect((await POST(makeRequest({ requestId: 'req-1' }) as never)).status).toBe(400);
  });

  it('rejects a grant addressed to a different node', async () => {
    const response = await POST(makeRequest(validBody({ grantedTo: 'did:imajin:othernode' })) as never);
    expect(response.status).toBe(400);
    // Never loosen this: it is what stops a grant meant for another node being
    // installed here, and a future porting design must not work around it.
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('returns 404 when no pending request matches', async () => {
    mockSelectLimit.mockResolvedValue([]);
    expect((await POST(makeRequest(validBody()) as never)).status).toBe(404);
  });

  it('rejects an ownerXPub that does not match the stored request', async () => {
    const response = await POST(makeRequest(validBody({ ownerXPub: '1'.repeat(64) })) as never);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects an invalid owner signature', async () => {
    mockVerifySync.mockReturnValue(false);
    const response = await POST(makeRequest(validBody()) as never);
    expect(response.status).toBe(403);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

// ── New behaviour ─────────────────────────────────────────────────────────────

describe('POST /api/vault/delegation/grant — self-describing grants', () => {
  it('accepts a valid grant and returns the new grantId', async () => {
    const response = await POST(makeRequest(validBody()) as never);
    const body = await response.json() as { ok: boolean; grantId: string; field: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.field).toBe('GH_TOKEN');
    expect(body.grantId).toBe('vdg_new');
  });

  it('records recipientXPub from the stored request row, not the request body', async () => {
    // The body is attacker-shaped input; the row was written by this node at seal
    // time. Taking it from the row is what makes the recorded pubkey trustworthy.
    await POST(makeRequest(validBody()) as never);

    const inserted = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted.recipientXPub).toBe(REQUEST_ROW_X_PUB);
  });

  it('pins the verifier the signature was actually checked against', async () => {
    await POST(makeRequest(validBody()) as never);

    const inserted = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    // Without this pin, unsetting the Tier 1 env would make the grant fail
    // verification against the node key instead — the one-way door.
    expect(inserted.ownerEdPub).toBe(OWNER_ED_PUB);
  });

  it('erases key material of the grant it supersedes', async () => {
    const superseded = [{ id: 'vdg_old', field: 'GH_TOKEN', keyId: 'kid:test' }];
    mockUpdateReturning.mockResolvedValue(superseded);

    await POST(makeRequest(validBody()) as never);

    // A replaced grant left intact would remain a usable copy of the old field key.
    expect(mockErase).toHaveBeenCalledWith(superseded);
  });

  it('does not erase anything when there was no previous grant', async () => {
    mockUpdateReturning.mockResolvedValue([]);

    await POST(makeRequest(validBody()) as never);

    expect(mockErase).toHaveBeenCalledWith([]);
  });
});

// ── Renewal (#1535) ───────────────────────────────────────────────────────────
//
// Expiry and revocation now destroy key material, so without an owner-initiated
// path a grant could only ever be minted at seal time and any lapse was a
// permanent lockout. A renewal carries no requestId: the request row exists to
// deliver a field key the owner does not have, and on renewal the owner already
// holds it in an envelope.

/** A renewal body — same shape as the handshake, minus the requestId. */
function renewalBody(overrides: Record<string, unknown> = {}) {
  return validBody({ requestId: undefined, ...overrides });
}

describe('POST /api/vault/delegation/grant — renewal', () => {
  it('accepts an owner-signed grant with no pending request row', async () => {
    const response = await POST(makeRequest(renewalBody()) as never);
    const body = await response.json() as { ok: boolean; grantId: string; renewal: boolean };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.renewal).toBe(true);
  });

  it('never consults the grant-request queue', async () => {
    await POST(makeRequest(renewalBody()) as never);

    // A renewal that looked for a pending row would 404 forever — the row was
    // consumed at seal time and is never recreated.
    expect(mockSelectLimit).not.toHaveBeenCalled();
  });

  it('records this node as the recipient rather than trusting the body', async () => {
    await POST(makeRequest(renewalBody()) as never);

    const inserted = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(inserted.recipientXPub).toBe(NODE_X_PUB);
    expect(inserted.ownerEdPub).toBe(OWNER_ED_PUB);
    expect(inserted.status).toBe('active');
  });

  it('supersedes and erases the lapsed grant it replaces', async () => {
    const superseded = [{ id: 'vdg_old', field: 'GH_TOKEN', keyId: 'kid:test' }];
    mockUpdateReturning.mockResolvedValue(superseded);

    await POST(makeRequest(renewalBody()) as never);

    expect(mockErase).toHaveBeenCalledWith(superseded);
  });

  it('rejects a renewal for a field with no entry', async () => {
    mockPeek.mockResolvedValue(undefined);

    const response = await POST(makeRequest(renewalBody()) as never);
    expect(response.status).toBe(404);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a renewal for a tombstoned field', async () => {
    mockPeek.mockResolvedValue(sealedEntry({ deleted: true }));

    const response = await POST(makeRequest(renewalBody()) as never);
    expect(response.status).toBe(404);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a renewal for a v1 node-sealed field', async () => {
    // A v1 entry is decrypted with the node seal key; a grant would be inert.
    mockPeek.mockResolvedValue(sealedEntry({ custodyScheme: undefined }));

    const response = await POST(makeRequest(renewalBody()) as never);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a keyId that does not match the current entry', async () => {
    // Installing a grant for a stale generation would produce a grant that cannot
    // decrypt the ciphertext it is attached to.
    const response = await POST(makeRequest(renewalBody({ keyId: 'kid:stale' })) as never);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a renewal when the owner holds no envelope', async () => {
    mockGetOwnerEnvelope.mockResolvedValue(undefined);

    const response = await POST(makeRequest(renewalBody()) as never);
    expect(response.status).toBe(404);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects an ownerXPub that does not match the envelope', async () => {
    // The envelope is node-written state and plays the role the request row plays
    // at seal time: it is what stops a substituted owner key.
    const response = await POST(makeRequest(renewalBody({ ownerXPub: '1'.repeat(64) })) as never);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a renewal signed by an untrusted key', async () => {
    mockVerifySync.mockReturnValue(false);

    const response = await POST(makeRequest(renewalBody()) as never);
    expect(response.status).toBe(403);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('still enforces the grantedTo binding', async () => {
    const response = await POST(makeRequest(renewalBody({ grantedTo: 'did:imajin:othernode' })) as never);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects an unparseable expiresAt', async () => {
    const response = await POST(makeRequest(renewalBody({ expiresAt: 'not-a-date' })) as never);
    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('carries the requested expiry onto the new grant', async () => {
    const expiresAt = '2030-01-01T00:00:00.000Z';
    await POST(makeRequest(renewalBody({ expiresAt })) as never);

    const inserted = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect((inserted.expiresAt as Date).toISOString()).toBe(expiresAt);
  });
});
