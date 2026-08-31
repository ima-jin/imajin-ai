import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSelect, mockInsert, mockUpdate, mockEmitAttestation, mockGetNodeDid } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockEmitAttestation: vi.fn(async () => undefined),
  mockGetNodeDid: vi.fn(async () => 'did:imajin:node'),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  identities: { id: 'identities.id' },
  credentials: { did: 'credentials.did', type: 'credentials.type', value: 'credentials.value' },
  claimStubIndex: {
    emailHmac: 'claim_stub_index.email_hmac',
    did: 'claim_stub_index.did',
    claimantVerifiedAt: 'claim_stub_index.claimant_verified_at',
    emailEncrypted: 'claim_stub_index.email_encrypted',
    stubStatus: 'claim_stub_index.stub_status',
    stubExpiresAt: 'claim_stub_index.stub_expires_at',
  },
  invitesInConnections: { toDid: 'invites.to_did', status: 'invites.status', id: 'invites.id' },
}));

vi.mock('@imajin/auth', () => ({
  emitAttestation: mockEmitAttestation,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: mockGetNodeDid,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import {
  hmacEmail,
  mintOrAccrueClaimableStub,
  resolveOrMintInviteTarget,
  isUnclaimedStub,
  findClaimableStubDid,
  verifyClaimantEmail,
  tryActivateClaim,
  withNoDisclosure,
} from '../claimable-stub';

/** No-op sleep so timing-floor padding (#1839) never slows down unit tests. */
const noSleep = async () => undefined;

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Chainable drizzle-style select builder mock resolving to `result`. */
function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

function queueSelect(...results: unknown[]) {
  for (const result of results) {
    mockSelect.mockImplementationOnce(() => selectChain(result));
  }
}

function insertChain() {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.onConflictDoNothing = vi.fn(async () => undefined);
  chain.returning = vi.fn(async () => []);
  chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return chain;
}

function updateChain(returning: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => returning);
  chain.then = (resolve: (v: unknown) => void) => resolve(undefined);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CLAIMABLE_STUB_EMAIL_SECRET = 'test-pepper-do-not-use-in-prod';
  mockInsert.mockImplementation(() => insertChain());
  mockUpdate.mockImplementation(() => updateChain());
});

// ─── hmacEmail ───────────────────────────────────────────────────────────────

describe('hmacEmail', () => {
  it('is deterministic and normalises case/whitespace', () => {
    expect(hmacEmail('Person@Example.com')).toBe(hmacEmail('  person@example.com  '));
  });

  it('differs between different emails', () => {
    expect(hmacEmail('a@example.com')).not.toBe(hmacEmail('b@example.com'));
  });

  it('throws when the server secret is not configured', () => {
    delete process.env.CLAIMABLE_STUB_EMAIL_SECRET;
    expect(() => hmacEmail('a@example.com')).toThrow('CLAIMABLE_STUB_EMAIL_SECRET');
  });
});

// ─── mintOrAccrueClaimableStub — mint-on-new-email + HMAC dedup accrual ────────

describe('mintOrAccrueClaimableStub', () => {
  it('mints a brand-new stub identity on first sight of an email', async () => {
    queueSelect([]); // no existing dedup-index row

    const result = await mintOrAccrueClaimableStub('new@example.com');

    expect(result.isNewStub).toBe(true);
    expect(result.did).toMatch(/^did:imajin:/);
    expect(mockInsert).toHaveBeenCalledTimes(2); // identities, then claim_stub_index
  });

  it('silently accrues a second introduction of the same email to the existing stub', async () => {
    const existingDid = 'did:imajin:existing-stub';
    queueSelect([{ did: existingDid }]); // dedup-index hit

    const result = await mintOrAccrueClaimableStub('repeat@example.com');

    expect(result.isNewStub).toBe(false);
    expect(result.did).toBe(existingDid);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('mints the same DID for repeat introductions across two separate calls (accrual, not duplication)', async () => {
    queueSelect([]); // first call: no existing row
    const first = await mintOrAccrueClaimableStub('same@example.com');

    queueSelect([{ did: first.did }]); // second call: dedup-index now has a hit
    const second = await mintOrAccrueClaimableStub('same@example.com');

    expect(second.did).toBe(first.did);
    expect(second.isNewStub).toBe(false);
  });

  it('stamps stub_expires_at ~CLAIMABLE_STUB_EXPIRY_DAYS (default 90d) ahead of now at mint time', async () => {
    queueSelect([]);
    const before = Date.now();

    await mintOrAccrueClaimableStub('fresh@example.com');

    const claimStubInsertCall = mockInsert.mock.results[1].value as ReturnType<typeof insertChain>;
    const insertedRow = (claimStubInsertCall.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as { stubExpiresAt: Date };
    const expectedMs = 90 * 24 * 60 * 60 * 1000;
    const deltaMs = insertedRow.stubExpiresAt.getTime() - before;
    expect(deltaMs).toBeGreaterThan(expectedMs - 5_000);
    expect(deltaMs).toBeLessThan(expectedMs + 5_000);
  });

  // ─── #1841: expired-then-reintroduced — mint a NEW stub, never resurrect ───

  it('mints a brand-new stub DID when the only prior row for this email has already expired (design consideration 3)', async () => {
    // The dedup lookup filters on stub_status = 'active'; a tombstoned
    // (`expired`) row for this email_hmac simply doesn't match — from
    // mintOrAccrueClaimableStub's point of view this is indistinguishable
    // from a genuinely new email (match-without-disclosure).
    queueSelect([]); // no ACTIVE row — the prior stub for this email already expired

    const result = await mintOrAccrueClaimableStub('reintroduced@example.com');

    expect(result.isNewStub).toBe(true);
    expect(result.did).toMatch(/^did:imajin:/);
    expect(mockInsert).toHaveBeenCalledTimes(2); // new identities row, new claim_stub_index row
    // The tombstoned row is never written to — no resurrection, and its old
    // accrual history (pods/connections/attestations on the old DID) is
    // left completely untouched by this call.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('mints a DID distinct from the tombstoned one on re-introduction, so forward accrual moves to the new stub', async () => {
    const tombstonedDid = 'did:imajin:tombstoned-stub';

    queueSelect([]); // no active row for this email (only the tombstoned one)
    const reintroduced = await mintOrAccrueClaimableStub('lapsed-then-back@example.com');

    expect(reintroduced.did).not.toBe(tombstonedDid);
    expect(reintroduced.isNewStub).toBe(true);
  });
});

// ─── resolveOrMintInviteTarget — no-disclosure response equivalence ───────────

describe('resolveOrMintInviteTarget', () => {
  it('reuses an existing real identity\u2019s DID without minting a stub', async () => {
    queueSelect([{ did: 'did:imajin:real-user' }]); // credentials hit

    const did = await resolveOrMintInviteTarget('real@example.com', noSleep);

    expect(did).toBe('did:imajin:real-user');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('mints a stub for a genuinely new email', async () => {
    queueSelect([], []); // no credentials row, no dedup-index row

    const did = await resolveOrMintInviteTarget('brand-new@example.com', noSleep);

    expect(did).toMatch(/^did:imajin:/);
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  it('returns the identical shape (just a DID string) whether minting or accruing — no-disclosure', async () => {
    queueSelect([], []); // first: mint
    const firstDid = await resolveOrMintInviteTarget('shared@example.com', noSleep);

    queueSelect([], [{ did: firstDid }]); // second: no credentials row, but dedup-index hit
    const secondDid = await resolveOrMintInviteTarget('shared@example.com', noSleep);

    expect(typeof firstDid).toBe('string');
    expect(typeof secondDid).toBe('string');
    expect(secondDid).toBe(firstDid); // accrues to the SAME stub — one DID per email
  });

  it('pads the fast (existing-real-user) path up to the same floor as the slower mint path (#1839 pt. 3)', async () => {
    queueSelect([{ did: 'did:imajin:real-user' }]); // credentials hit — the cheapest branch

    const sleepCalls: number[] = [];
    const recordingSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await resolveOrMintInviteTarget('real@example.com', recordingSleep);

    // The fast branch still pays the latency floor instead of returning early.
    expect(sleepCalls.length).toBe(1);
    expect(sleepCalls[0]).toBeGreaterThan(0);
  });

  it('does not pad further when the work already exceeded the floor', async () => {
    process.env.CLAIMABLE_STUB_MIN_RESOLVE_MS = '0';
    queueSelect([{ did: 'did:imajin:real-user' }]);

    const sleepCalls: number[] = [];
    const recordingSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await resolveOrMintInviteTarget('real@example.com', recordingSleep);

    expect(sleepCalls.length).toBe(0);
    delete process.env.CLAIMABLE_STUB_MIN_RESOLVE_MS;
  });
});

// ─── withNoDisclosure — the response-side half of the #1839 contract ────────

describe('withNoDisclosure', () => {
  it('strips toDid from a pending invite', () => {
    const invite = { toDid: 'did:imajin:target', status: 'pending' };
    expect(withNoDisclosure(invite)).toEqual({ toDid: null, status: 'pending' });
  });

  it('strips toDid from an expired or revoked invite too — only accepted discloses', () => {
    expect(withNoDisclosure({ toDid: 'did:imajin:target', status: 'expired' }).toDid).toBeNull();
    expect(withNoDisclosure({ toDid: 'did:imajin:target', status: 'revoked' }).toDid).toBeNull();
  });

  it('leaves an accepted invite untouched — post-claim disclosure is legitimate (#1839 pt. 4)', () => {
    const invite = { toDid: 'did:imajin:target', status: 'accepted' };
    expect(withNoDisclosure(invite)).toEqual(invite);
  });
});

// ─── isUnclaimedStub ─────────────────────────────────────────────────────────

describe('isUnclaimedStub', () => {
  it('is false when the DID is not one of our claimable stubs', async () => {
    queueSelect([]); // no claim_stub_index row

    expect(await isUnclaimedStub('did:imajin:not-a-stub')).toBe(false);
  });

  it('is false once the stub has already activated to preliminary', async () => {
    queueSelect([{ did: 'did:imajin:stub', stubStatus: 'active' }], [{ tier: 'preliminary' }]);

    expect(await isUnclaimedStub('did:imajin:stub')).toBe(false);
  });

  it('is true for a still-soft claimable stub', async () => {
    queueSelect([{ did: 'did:imajin:stub', stubStatus: 'active' }], [{ tier: 'soft' }]);

    expect(await isUnclaimedStub('did:imajin:stub')).toBe(true);
  });

  it('is false for a tombstoned (expired) stub, even though tier is still soft (#1841)', async () => {
    // The expiry sweep flips stub_status before it would ever need to touch
    // tier — isUnclaimedStub must close the link-click-alone accept path on
    // stub_status alone, not wait for a tier change that may never happen.
    queueSelect([{ did: 'did:imajin:stub', stubStatus: 'expired' }]);

    expect(await isUnclaimedStub('did:imajin:stub')).toBe(false);
  });
});

// ─── findClaimableStubDid (#1834 Phase 2) ─────────────────────────────────────

describe('findClaimableStubDid', () => {
  it('returns null when no stub exists for the email', async () => {
    queueSelect([]);

    expect(await findClaimableStubDid('unknown@example.com')).toBeNull();
  });

  it('returns the existing stub DID without minting anything', async () => {
    queueSelect([{ did: 'did:imajin:existing-stub' }]);

    expect(await findClaimableStubDid('known@example.com')).toBe('did:imajin:existing-stub');
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ─── The ratchet: unverified click ≠ claim; verify + countersign = claim ──────

describe('tryActivateClaim — bilateral ratchet', () => {
  const STUB_DID = 'did:imajin:stub-under-claim';

  it('does not activate on an accepted invite alone (claimant never verified) — click alone is not a claim', async () => {
    queueSelect([{ claimantVerifiedAt: null, emailEncrypted: 'irrelevant', stubStatus: 'active' }]);

    const activated = await tryActivateClaim(STUB_DID);

    expect(activated).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not activate on claimant verification alone (invite not yet accepted)', async () => {
    queueSelect(
      [{ claimantVerifiedAt: new Date(), emailEncrypted: 'irrelevant', stubStatus: 'active' }],
      [], // no accepted invite targeting this DID
    );

    const activated = await tryActivateClaim(STUB_DID);

    expect(activated).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('activates once BOTH signals are present — verify + inviter countersign = claim', async () => {
    mockUpdate.mockImplementationOnce(() => updateChain([{ id: STUB_DID }]));

    queueSelect(
      [{ claimantVerifiedAt: new Date(), emailEncrypted: encryptedFor('claim-me@example.com'), stubStatus: 'active' }],
      [{ id: 'inv_abc' }], // an accepted invite targets this DID
    );

    const activated = await tryActivateClaim(STUB_DID);

    expect(activated).toBe(true);
    // Tier flip is a CAS update on identities.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // The recovered plaintext email lands in a new credentials row, verified.
    const insertCall = mockInsert.mock.results[0].value as ReturnType<typeof insertChain>;
    expect((insertCall.values as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ did: STUB_DID, type: 'email', value: 'claim-me@example.com' }),
    );
    expect(mockEmitAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ subject_did: STUB_DID, type: 'identity.verified.preliminary' }),
    );
  });

  it('is idempotent: a concurrent/repeat call after activation is a safe no-op that still reports success', async () => {
    // CAS returns nothing because tier is no longer 'soft' (already activated).
    mockUpdate.mockImplementationOnce(() => updateChain([]));

    queueSelect(
      [{ claimantVerifiedAt: new Date(), emailEncrypted: encryptedFor('claim-me@example.com'), stubStatus: 'active' }],
      [{ id: 'inv_abc' }],
    );

    const activated = await tryActivateClaim(STUB_DID);

    expect(activated).toBe(true);
    expect(mockInsert).not.toHaveBeenCalled(); // no duplicate credentials row
  });

  it('keeps the same DID through the entire claim — the DID never changes', async () => {
    mockUpdate.mockImplementationOnce(() => updateChain([{ id: STUB_DID }]));
    queueSelect(
      [{ claimantVerifiedAt: new Date(), emailEncrypted: encryptedFor('stable@example.com'), stubStatus: 'active' }],
      [{ id: 'inv_abc' }],
    );

    await tryActivateClaim(STUB_DID);

    // Every DB call that names a DID uses the same STUB_DID throughout.
    const insertCall = mockInsert.mock.results[0].value as ReturnType<typeof insertChain>;
    expect((insertCall.values as ReturnType<typeof vi.fn>).mock.calls[0][0].did).toBe(STUB_DID);
    expect(mockEmitAttestation).toHaveBeenCalledWith(expect.objectContaining({ subject_did: STUB_DID }));
  });

  // ─── #1841: post-expiry activation-race guard ───────────────────────────────

  it('refuses to activate against a stub already swept to expired, even with both signals present (post-expiry activation-race guard)', async () => {
    // Simulates the race the guard exists to close: the expiry sweep flips
    // stub_status to 'expired' in between the claimant's email verification
    // landing and the inviter's countersign being checked here.
    queueSelect(
      [{ claimantVerifiedAt: new Date(), emailEncrypted: encryptedFor('too-late@example.com'), stubStatus: 'expired' }],
    );

    const activated = await tryActivateClaim(STUB_DID);

    expect(activated).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockEmitAttestation).not.toHaveBeenCalled();
  });
});

describe('verifyClaimantEmail', () => {
  it('returns false when the email matches no known stub', async () => {
    queueSelect([]);

    expect(await verifyClaimantEmail('unknown@example.com')).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('marks the stub verified and defers to tryActivateClaim for the rest of the ratchet', async () => {
    const did = 'did:imajin:to-verify';
    queueSelect(
      [{ did }], // hmac lookup hit (active row)
      [{ claimantVerifiedAt: new Date(), emailEncrypted: encryptedFor('v@example.com'), stubStatus: 'active' }], // tryActivateClaim's own lookup
      [], // no accepted invite yet
    );

    const activated = await verifyClaimantEmail('v@example.com');

    // Claimant-side flag was written...
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // ...but bilateral completion still requires the inviter-side countersign.
    expect(activated).toBe(false);
  });

  it('returns false when the only row for this email has already lapsed (#1841) — an expired stub is not claimable', async () => {
    // The emailHmac lookup here is filtered to stub_status = 'active'; a
    // tombstoned row for this email simply doesn't match.
    queueSelect([]);

    expect(await verifyClaimantEmail('lapsed@example.com')).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ─── Helper: produce a real encrypted-email blob using the same routine ───────
// under test, so ratchet-activation tests exercise the genuine AES-GCM
// round trip rather than a stubbed value.

function encryptedFor(email: string): string {
  const key = createHmac('sha256', process.env.CLAIMABLE_STUB_EMAIL_SECRET as string)
    .update('claimable-stub-email-encryption')
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(email.toLowerCase().trim(), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString('base64url')).join(':');
}
