/**
 * Tests for the Buzz DID attribution resolver (#1413, #1415).
 *
 * Covers the write path (loadDidTags), the read path (resolveDidFromEvent),
 * and the revocation path:
 *   - active binding    → { did, status: 'active' }
 *   - revoked binding   → { did, status: 'revoked', revokedAt, validAtEventTime }
 *   - no matching row   → null
 *
 * The DB is mocked; no real database connection is required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { canonicalize, nostrAttestationDigest, bytesToHex } from '@imajin/auth';

// ── DB mock ───────────────────────────────────────────────────────────────────

/**
 * Shared state for the fake DB.  whereImpl closes over `state.rows` so the
 * mock returns whatever is placed there by each test without reloading modules.
 */
const { mockState } = vi.hoisted(() => {
  const mockState: { rows: unknown[] } = { rows: [] };
  return { mockState };
});

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = mockState.rows;
          return Object.assign(Promise.resolve(rows), {
            limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          });
        },
      }),
    }),
  },
  attestations: {},
}));

// ── Imports after mock setup ──────────────────────────────────────────────────

import {
  buildKind9Event,
  deriveNostrPubkey,
  generateNostrPrivkey,
} from '../nostr-event';
import { loadDidTags, resolveDidFromEvent, type ResolveResult } from '../did-resolver';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const PRIV = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';
const PUB = deriveNostrPubkey(PRIV);
const OWNER_DID = 'did:imajin:jin';
const ISSUED_AT_MS = 1_753_000_000_000;

/** A realistic mock for auth.attestations row. */
const MOCK_ROW = {
  id: 'att_test001',
  issuerDid: OWNER_DID,
  subjectDid: OWNER_DID,
  type: 'imajin/nostr-key-binding',
  contextId: null,
  contextType: null,
  payload: {
    nostr_pubkey: PUB,
    npub: 'npub1placeholder',
    purpose: 'buzz-workspace-participation',
    issued_at: ISSUED_AT_MS,
  },
  signature: 'fakesig',
  cid: null,
  nostrSig: 'fakenostrsig',
  authorJws: null,
  witnessJws: null,
  attestationStatus: 'pending',
  documentHash: null,
  documentAssetId: null,
  totalSigners: null,
  issuedAt: new Date(ISSUED_AT_MS),
  expiresAt: null,
  revokedAt: null,
};

/** The digest that loadDidTags / resolveDidFromEvent must produce for MOCK_ROW. */
function computeExpectedDigest(row: typeof MOCK_ROW): string {
  const canonical = canonicalize({
    subject_did: row.subjectDid,
    type: row.type,
    context_id: row.contextId ?? null,
    context_type: row.contextType ?? null,
    payload: row.payload ?? null,
    issued_at: row.issuedAt.getTime(),
  });
  return bytesToHex(nostrAttestationDigest(canonical));
}

const EXPECTED_DIGEST = computeExpectedDigest(MOCK_ROW);

beforeEach(() => {
  mockState.rows = [];
});

// ── loadDidTags ───────────────────────────────────────────────────────────────

describe('loadDidTags', () => {
  it('returns undefined when no attestation exists', async () => {
    mockState.rows = [];
    expect(await loadDidTags(OWNER_DID)).toBeUndefined();
  });

  it('returns DidTags with the correct ownerDid', async () => {
    mockState.rows = [MOCK_ROW];
    const tags = await loadDidTags(OWNER_DID);
    expect(tags?.ownerDid).toBe(OWNER_DID);
  });

  it('returns a 64-char hex attestationDigest', async () => {
    mockState.rows = [MOCK_ROW];
    const tags = await loadDidTags(OWNER_DID);
    expect(tags?.attestationDigest).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(tags?.attestationDigest ?? '')).toBe(true);
  });

  it('digest is deterministic (same row → same digest)', async () => {
    mockState.rows = [MOCK_ROW];
    const a = await loadDidTags(OWNER_DID);
    const b = await loadDidTags(OWNER_DID);
    expect(a?.attestationDigest).toBe(b?.attestationDigest);
  });

  it('digest matches the independently-computed canonical digest', async () => {
    mockState.rows = [MOCK_ROW];
    const tags = await loadDidTags(OWNER_DID);
    expect(tags?.attestationDigest).toBe(EXPECTED_DIGEST);
  });

  it('digest changes when the attestation payload changes', async () => {
    mockState.rows = [MOCK_ROW];
    const tags1 = await loadDidTags(OWNER_DID);

    const mutated = {
      ...MOCK_ROW,
      payload: { ...MOCK_ROW.payload, purpose: 'different-purpose' },
    };
    mockState.rows = [mutated];
    const tags2 = await loadDidTags(OWNER_DID);

    expect(tags1?.attestationDigest).not.toBe(tags2?.attestationDigest);
  });
});

// ── resolveDidFromEvent — active binding ──────────────────────────────────────

describe('resolveDidFromEvent — active binding', () => {
  it('returns null for an event with no DID tags', async () => {
    mockState.rows = [MOCK_ROW];
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV);
    expect(await resolveDidFromEvent(event)).toBeNull();
  });

  it('returns null when imajin-did is present but imajin-attestation is missing', async () => {
    mockState.rows = [MOCK_ROW];
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV);
    const partial = {
      ...event,
      tags: [...event.tags, ['imajin-did', OWNER_DID]],
    };
    expect(await resolveDidFromEvent(partial)).toBeNull();
  });

  it('returns null when the DB has no matching attestation', async () => {
    mockState.rows = [];
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    expect(await resolveDidFromEvent(event)).toBeNull();
  });

  it('returns null when the event pubkey does not match payload.nostr_pubkey', async () => {
    const otherPriv = generateNostrPrivkey();
    const otherPub = deriveNostrPubkey(otherPriv);
    mockState.rows = [MOCK_ROW];
    const event = buildKind9Event(otherPub, 'group-1', 'hello', otherPriv, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    expect(await resolveDidFromEvent(event)).toBeNull();
  });

  it('returns null when the attestationDigest tag is wrong', async () => {
    mockState.rows = [MOCK_ROW];
    const wrongDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: wrongDigest,
    });
    expect(await resolveDidFromEvent(event)).toBeNull();
  });

  it('round-trip: resolves status=active and correct DID', async () => {
    mockState.rows = [MOCK_ROW];
    const event = buildKind9Event(PUB, 'group-1', 'Agent says hi', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    const result = await resolveDidFromEvent(event);
    expect(result?.status).toBe('active');
    expect(result?.did).toBe(OWNER_DID);
  });

  it('round-trip: loadDidTags + resolveDidFromEvent agree on DID and status', async () => {
    mockState.rows = [MOCK_ROW];
    const didTags = await loadDidTags(OWNER_DID);
    expect(didTags).toBeDefined();

    const event = buildKind9Event(PUB, 'group-1', 'Round-trip', PRIV, didTags);
    const result = await resolveDidFromEvent(event);
    expect(result?.status).toBe('active');
    expect(result?.did).toBe(OWNER_DID);
  });
});

// ── resolveDidFromEvent — revocation path (#1415) ─────────────────────────────

/** Build a row with revokedAt set to the given timestamp. */
function revokedRow(revokedAtMs: number) {
  return { ...MOCK_ROW, revokedAt: new Date(revokedAtMs) };
}

describe('resolveDidFromEvent — revocation path', () => {
  it('returns status=revoked when the only matching attestation is revoked', async () => {
    // Revoked 1 hour after issuance
    mockState.rows = [revokedRow(ISSUED_AT_MS + 3_600_000)];
    const event = buildKind9Event(PUB, 'group-1', 'old message', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    const result = await resolveDidFromEvent(event);
    expect(result?.status).toBe('revoked');
    expect(result?.did).toBe(OWNER_DID);
  });

  it('revokedAt matches the row\'s revokedAt date', async () => {
    const revokedAtMs = ISSUED_AT_MS + 3_600_000;
    mockState.rows = [revokedRow(revokedAtMs)];
    const event = buildKind9Event(PUB, 'group-1', 'msg', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    const result = await resolveDidFromEvent(event) as Extract<ResolveResult, { status: 'revoked' }>;
    expect(result.revokedAt).toEqual(new Date(revokedAtMs));
  });

  it('validAtEventTime=true when event was signed BEFORE revocation', async () => {
    // Event created_at is in Unix seconds; revokedAt is later in ms
    const revokedAtMs = ISSUED_AT_MS + 3_600_000; // 1 hour after issuance
    mockState.rows = [revokedRow(revokedAtMs)];

    // Build an event timestamped BEFORE the revocation
    const eventCreatedAtSec = Math.floor((ISSUED_AT_MS + 1_800_000) / 1000); // 30 min after issuance
    const event = {
      ...buildKind9Event(PUB, 'group-1', 'historical msg', PRIV, {
        ownerDid: OWNER_DID,
        attestationDigest: EXPECTED_DIGEST,
      }),
      created_at: eventCreatedAtSec,
    };
    const result = await resolveDidFromEvent(event) as Extract<ResolveResult, { status: 'revoked' }>;
    expect(result.validAtEventTime).toBe(true);
  });

  it('validAtEventTime=false when event was signed AFTER revocation', async () => {
    const revokedAtMs = ISSUED_AT_MS + 1_800_000; // 30 min after issuance
    mockState.rows = [revokedRow(revokedAtMs)];

    // Build an event timestamped AFTER the revocation
    const eventCreatedAtSec = Math.floor((ISSUED_AT_MS + 3_600_000) / 1000); // 1 hour after issuance
    const event = {
      ...buildKind9Event(PUB, 'group-1', 'post-revocation msg', PRIV, {
        ownerDid: OWNER_DID,
        attestationDigest: EXPECTED_DIGEST,
      }),
      created_at: eventCreatedAtSec,
    };
    const result = await resolveDidFromEvent(event) as Extract<ResolveResult, { status: 'revoked' }>;
    expect(result.validAtEventTime).toBe(false);
  });

  it('active binding wins over revoked binding for the same DID', async () => {
    // Two rows for the same DID: one revoked, one active
    const revoked = revokedRow(ISSUED_AT_MS + 3_600_000);
    const active = MOCK_ROW; // revokedAt: null
    mockState.rows = [revoked, active];

    const event = buildKind9Event(PUB, 'group-1', 'msg', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    const result = await resolveDidFromEvent(event);
    expect(result?.status).toBe('active');
  });

  // Note: loadDidTags skips revoked rows via `isNull(attestations.revokedAt)` in
  // the WHERE clause. That SQL filter is enforced by the real database; the mock
  // here doesn't implement column-level filtering, so we don't test it at this
  // level. The WHERE clause in did-resolver.ts is the source of truth.
});
