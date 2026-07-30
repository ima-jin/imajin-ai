/**
 * Tests for Imajin DID attribution tags on NIP-29 kind:9 events (#1413).
 *
 * Verifies that buildKind9Event injects [imajin-did] + [imajin-attestation]
 * tags when DidTags are provided, and that the event signature remains valid.
 */
import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { hexToBytes } from '@imajin/auth';
import { buildKind9Event, deriveNostrPubkey, type DidTags } from '../nostr-event';

const PRIV = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const PUB = deriveNostrPubkey(PRIV);
const GROUP_ID = 'buzz-workspace-123';
const CONTENT = 'Hello from the Imajin agent!';
const OWNER_DID = 'did:imajin:agent-jin';
const DIGEST = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const DID_TAGS: DidTags = { ownerDid: OWNER_DID, attestationDigest: DIGEST };

// ── buildKind9Event without didTags (backward compat) ─────────────────────────

describe('buildKind9Event — no didTags (backward compat)', () => {
  it('includes only the #h group tag', () => {
    const event = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV);
    expect(event.tags).toHaveLength(1);
    expect(event.tags[0]).toEqual(['h', GROUP_ID]);
  });

  it('does not carry imajin-did or imajin-attestation tags', () => {
    const event = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV);
    const tagNames = new Set(event.tags.map((t) => t[0]));
    expect(tagNames.has('imajin-did')).toBe(false);
    expect(tagNames.has('imajin-attestation')).toBe(false);
  });
});

// ── buildKind9Event with didTags ──────────────────────────────────────────────

describe('buildKind9Event — with didTags', () => {
  it('appends [imajin-did, ownerDid] after the #h tag', () => {
    const event = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, DID_TAGS);
    const didTag = event.tags.find((t) => t[0] === 'imajin-did');
    expect(didTag).toEqual(['imajin-did', OWNER_DID]);
  });

  it('appends [imajin-attestation, digest] after the imajin-did tag', () => {
    const event = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, DID_TAGS);
    const attTag = event.tags.find((t) => t[0] === 'imajin-attestation');
    expect(attTag).toEqual(['imajin-attestation', DIGEST]);
  });

  it('produces exactly 3 tags: #h + imajin-did + imajin-attestation', () => {
    const event = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, DID_TAGS);
    expect(event.tags).toHaveLength(3);
  });

  it('retains the required #h group tag', () => {
    const event = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, DID_TAGS);
    const hTag = event.tags.find((t) => t[0] === 'h');
    expect(hTag).toEqual(['h', GROUP_ID]);
  });

  it('event signature is still valid (Schnorr over the full tag set)', () => {
    const event = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, DID_TAGS);
    expect(schnorr.verify(event.sig, hexToBytes(event.id), PUB)).toBe(true);
  });

  it('event id changes when ownerDid changes (tags are committed to id)', () => {
    const e1 = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, DID_TAGS);
    const e2 = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, {
      ...DID_TAGS,
      ownerDid: 'did:imajin:other',
    });
    expect(e1.id).not.toBe(e2.id);
  });

  it('event id changes when attestationDigest changes', () => {
    const e1 = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, DID_TAGS);
    const e2 = buildKind9Event(PUB, GROUP_ID, CONTENT, PRIV, {
      ...DID_TAGS,
      attestationDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(e1.id).not.toBe(e2.id);
  });
});
