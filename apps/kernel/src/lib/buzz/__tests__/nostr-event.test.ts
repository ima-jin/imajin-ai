import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { hexToBytes } from '@imajin/auth';
import {
  computeEventId,
  signNostrEvent,
  deriveNostrPubkey,
  generateNostrPrivkey,
  buildAuthEvent,
  buildKind9Event,
  type UnsignedNostrEvent,
} from '../nostr-event';

// ── Deterministic test keys (NOT for production use) ─────────────────────────
const PRIV_A = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const PUB_A = deriveNostrPubkey(PRIV_A);

const PRIV_B = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const PUB_B = deriveNostrPubkey(PRIV_B);

const BASE_EVENT: UnsignedNostrEvent = {
  pubkey: PUB_A,
  created_at: 1_753_487_070,
  kind: 9,
  tags: [['h', 'test-group']],
  content: 'hello buzz',
};

// ── computeEventId ────────────────────────────────────────────────────────────

describe('computeEventId', () => {
  it('returns a 64-char hex string (32-byte SHA-256)', () => {
    const id = computeEventId(BASE_EVENT);
    expect(id).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('is deterministic for the same event', () => {
    expect(computeEventId(BASE_EVENT)).toBe(computeEventId(BASE_EVENT));
  });

  it('changes when content changes', () => {
    const id1 = computeEventId(BASE_EVENT);
    const id2 = computeEventId({ ...BASE_EVENT, content: 'different' });
    expect(id1).not.toBe(id2);
  });

  it('changes when kind changes', () => {
    const id1 = computeEventId(BASE_EVENT);
    const id2 = computeEventId({ ...BASE_EVENT, kind: 22242 });
    expect(id1).not.toBe(id2);
  });

  it('changes when tags change', () => {
    const id1 = computeEventId(BASE_EVENT);
    const id2 = computeEventId({ ...BASE_EVENT, tags: [['h', 'other-group']] });
    expect(id1).not.toBe(id2);
  });

  it('changes when pubkey changes', () => {
    const id1 = computeEventId(BASE_EVENT);
    const id2 = computeEventId({ ...BASE_EVENT, pubkey: PUB_B });
    expect(id1).not.toBe(id2);
  });

  it('changes when created_at changes', () => {
    const id1 = computeEventId(BASE_EVENT);
    const id2 = computeEventId({ ...BASE_EVENT, created_at: 1_753_487_071 });
    expect(id1).not.toBe(id2);
  });
});

// ── signNostrEvent ────────────────────────────────────────────────────────────

describe('signNostrEvent', () => {
  it('produces a complete event with id and sig', () => {
    const event = signNostrEvent(BASE_EVENT, PRIV_A);
    expect(event.id).toHaveLength(64);
    expect(event.sig).toHaveLength(128); // 64-byte Schnorr sig → 128 hex chars
    expect(event.pubkey).toBe(PUB_A);
    expect(event.kind).toBe(9);
  });

  it('id matches computeEventId', () => {
    const event = signNostrEvent(BASE_EVENT, PRIV_A);
    expect(event.id).toBe(computeEventId(BASE_EVENT));
  });

  it('sig verifies with the correct public key (schnorr.verify)', () => {
    const event = signNostrEvent(BASE_EVENT, PRIV_A);
    const valid = schnorr.verify(event.sig, hexToBytes(event.id), PUB_A);
    expect(valid).toBe(true);
  });

  it('sig fails verification with the wrong public key', () => {
    const event = signNostrEvent(BASE_EVENT, PRIV_A);
    const valid = schnorr.verify(event.sig, hexToBytes(event.id), PUB_B);
    expect(valid).toBe(false);
  });

  it('sig fails verification for a tampered event', () => {
    const event = signNostrEvent(BASE_EVENT, PRIV_A);
    const tamperedId = computeEventId({ ...BASE_EVENT, content: 'tampered' });
    const valid = schnorr.verify(event.sig, hexToBytes(tamperedId), PUB_A);
    expect(valid).toBe(false);
  });

  it('two different private keys produce different sigs', () => {
    const eventA = signNostrEvent(BASE_EVENT, PRIV_A);
    const eventB = signNostrEvent({ ...BASE_EVENT, pubkey: PUB_B }, PRIV_B);
    expect(eventA.sig).not.toBe(eventB.sig);
  });
});

// ── deriveNostrPubkey ─────────────────────────────────────────────────────────

describe('deriveNostrPubkey', () => {
  it('returns a 64-char hex string (x-only 32-byte key)', () => {
    expect(PUB_A).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(PUB_A)).toBe(true);
  });

  it('is deterministic', () => {
    expect(deriveNostrPubkey(PRIV_A)).toBe(PUB_A);
  });

  it('two different privkeys produce different pubkeys', () => {
    expect(PUB_A).not.toBe(PUB_B);
  });
});

// ── generateNostrPrivkey ──────────────────────────────────────────────────────

describe('generateNostrPrivkey', () => {
  it('returns a 64-char hex string', () => {
    const priv = generateNostrPrivkey();
    expect(priv).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(priv)).toBe(true);
  });

  it('produces a different key each call', () => {
    const a = generateNostrPrivkey();
    const b = generateNostrPrivkey();
    expect(a).not.toBe(b);
  });

  it('derived public key is usable for signing', () => {
    const priv = generateNostrPrivkey();
    const pub = deriveNostrPubkey(priv);
    const event = signNostrEvent({ ...BASE_EVENT, pubkey: pub }, priv);
    expect(schnorr.verify(event.sig, hexToBytes(event.id), pub)).toBe(true);
  });
});

// ── buildAuthEvent (NIP-42) ───────────────────────────────────────────────────

describe('buildAuthEvent', () => {
  const RELAY_URL = 'wss://relay.buzz.example.com';
  const CHALLENGE = 'abc123challenge';

  it('produces kind:22242', () => {
    const event = buildAuthEvent(PUB_A, RELAY_URL, CHALLENGE, PRIV_A);
    expect(event.kind).toBe(22242);
  });

  it('includes relay and challenge tags', () => {
    const event = buildAuthEvent(PUB_A, RELAY_URL, CHALLENGE, PRIV_A);
    const relayTag = event.tags.find((t) => t[0] === 'relay');
    const challengeTag = event.tags.find((t) => t[0] === 'challenge');
    expect(relayTag).toEqual(['relay', RELAY_URL]);
    expect(challengeTag).toEqual(['challenge', CHALLENGE]);
  });

  it('has empty content', () => {
    const event = buildAuthEvent(PUB_A, RELAY_URL, CHALLENGE, PRIV_A);
    expect(event.content).toBe('');
  });

  it('has a valid signature', () => {
    const event = buildAuthEvent(PUB_A, RELAY_URL, CHALLENGE, PRIV_A);
    expect(schnorr.verify(event.sig, hexToBytes(event.id), PUB_A)).toBe(true);
  });

  it('different challenges produce different event IDs', () => {
    const e1 = buildAuthEvent(PUB_A, RELAY_URL, 'challenge-1', PRIV_A);
    const e2 = buildAuthEvent(PUB_A, RELAY_URL, 'challenge-2', PRIV_A);
    expect(e1.id).not.toBe(e2.id);
  });
});

// ── buildKind9Event (NIP-29) ──────────────────────────────────────────────────

describe('buildKind9Event', () => {
  const GROUP_ID = 'buzz-workspace-123';
  const CONTENT = 'Hello from the Imajin agent!';

  it('produces kind:9', () => {
    const event = buildKind9Event(PUB_A, GROUP_ID, CONTENT, PRIV_A);
    expect(event.kind).toBe(9);
  });

  it('includes the required #h group tag', () => {
    const event = buildKind9Event(PUB_A, GROUP_ID, CONTENT, PRIV_A);
    const hTag = event.tags.find((t) => t[0] === 'h');
    expect(hTag).toEqual(['h', GROUP_ID]);
  });

  it('carries the correct content', () => {
    const event = buildKind9Event(PUB_A, GROUP_ID, CONTENT, PRIV_A);
    expect(event.content).toBe(CONTENT);
  });

  it('has a valid Schnorr signature', () => {
    const event = buildKind9Event(PUB_A, GROUP_ID, CONTENT, PRIV_A);
    expect(schnorr.verify(event.sig, hexToBytes(event.id), PUB_A)).toBe(true);
  });

  it('different groups produce different event IDs', () => {
    const e1 = buildKind9Event(PUB_A, 'group-a', CONTENT, PRIV_A);
    const e2 = buildKind9Event(PUB_A, 'group-b', CONTENT, PRIV_A);
    expect(e1.id).not.toBe(e2.id);
  });

  it('different content produces a different event ID', () => {
    const e1 = buildKind9Event(PUB_A, GROUP_ID, 'msg-1', PRIV_A);
    const e2 = buildKind9Event(PUB_A, GROUP_ID, 'msg-2', PRIV_A);
    expect(e1.id).not.toBe(e2.id);
  });
});
