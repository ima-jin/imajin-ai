/**
 * Tests for the Buzz DID attribution resolver (#1413).
 *
 * Covers both the write path (loadDidTags) and the read path (resolveDidFromEvent).
 * The DB is mocked so no real database connection is required.
 *
 * Round-trip test:
 *   1. Compute the real canonical-payload digest for a mock attestation row.
 *   2. Build a kind:9 event with those DID tags.
 *   3. Feed the event to resolveDidFromEvent with the mock row in the DB.
 *   4. Assert the resolved DID matches the expected value.
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
import { loadDidTags, resolveDidFromEvent } from '../did-resolver';

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

// ── resolveDidFromEvent ───────────────────────────────────────────────────────

describe('resolveDidFromEvent', () => {
  it('returns undefined for an event with no DID tags', async () => {
    mockState.rows = [MOCK_ROW];
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV);
    expect(await resolveDidFromEvent(event)).toBeUndefined();
  });

  it('returns undefined when the imajin-did tag is present but imajin-attestation is missing', async () => {
    mockState.rows = [MOCK_ROW];
    // Manually craft an event with only the imajin-did tag
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV);
    const partial = {
      ...event,
      tags: [...event.tags, ['imajin-did', OWNER_DID]],
    };
    expect(await resolveDidFromEvent(partial)).toBeUndefined();
  });

  it('returns undefined when the DB has no matching attestation', async () => {
    mockState.rows = [];
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    expect(await resolveDidFromEvent(event)).toBeUndefined();
  });

  it('returns undefined when the event pubkey does not match payload.nostr_pubkey', async () => {
    const otherPriv = generateNostrPrivkey();
    const otherPub = deriveNostrPubkey(otherPriv);

    // Attestation is for MOCK_ROW.payload.nostr_pubkey = PUB,
    // but the event is signed by otherPub
    mockState.rows = [MOCK_ROW];
    const event = buildKind9Event(otherPub, 'group-1', 'hello', otherPriv, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    expect(await resolveDidFromEvent(event)).toBeUndefined();
  });

  it('returns undefined when the attestationDigest tag is wrong', async () => {
    mockState.rows = [MOCK_ROW];
    const wrongDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const event = buildKind9Event(PUB, 'group-1', 'hello', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: wrongDigest,
    });
    expect(await resolveDidFromEvent(event)).toBeUndefined();
  });

  it('round-trip: resolves the correct DID from an event with real DID tags', async () => {
    mockState.rows = [MOCK_ROW];
    // Build an event using the real digest computed from MOCK_ROW
    const event = buildKind9Event(PUB, 'group-1', 'Agent says hi', PRIV, {
      ownerDid: OWNER_DID,
      attestationDigest: EXPECTED_DIGEST,
    });
    const resolved = await resolveDidFromEvent(event);
    expect(resolved).toBe(OWNER_DID);
  });

  it('round-trip: resolved DID matches loadDidTags ownerDid', async () => {
    mockState.rows = [MOCK_ROW];
    const didTags = await loadDidTags(OWNER_DID);
    expect(didTags).toBeDefined();

    const event = buildKind9Event(PUB, 'group-1', 'Round-trip', PRIV, didTags);
    const resolved = await resolveDidFromEvent(event);
    expect(resolved).toBe(OWNER_DID);
  });
});
