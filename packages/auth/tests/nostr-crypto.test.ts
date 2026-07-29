import { describe, it, expect } from 'vitest';
import {
  verifyNostrSig,
  signNostrAttestation,
  getNostrPublicKey,
  nostrAttestationDigest,
} from '../src/nostr-crypto';

// Deterministic 32-byte test private key (NOT for production use)
const PRIV_A = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const PRIV_B = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';

const PUB_A = getNostrPublicKey(PRIV_A);
const PUB_B = getNostrPublicKey(PRIV_B);

const CANONICAL = '{"issued_at":1753487070000,"payload":{"nostr_pubkey":"deadbeef","npub":"npub1deadbeef","purpose":"buzz-workspace-participation"},"subject_did":"did:imajin:test123","type":"imajin/nostr-key-binding"}';

describe('nostrAttestationDigest', () => {
  it('returns a 32-byte Uint8Array', () => {
    const digest = nostrAttestationDigest(CANONICAL);
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
  });

  it('is deterministic for the same input', () => {
    const d1 = nostrAttestationDigest(CANONICAL);
    const d2 = nostrAttestationDigest(CANONICAL);
    expect(d1).toEqual(d2);
  });

  it('differs for different inputs', () => {
    const d1 = nostrAttestationDigest(CANONICAL);
    const d2 = nostrAttestationDigest(CANONICAL + ' ');
    expect(d1).not.toEqual(d2);
  });
});

describe('signNostrAttestation + verifyNostrSig', () => {
  it('round-trips: sign then verify succeeds', () => {
    const sig = signNostrAttestation(CANONICAL, PRIV_A);
    expect(sig).toHaveLength(128); // 64-byte Schnorr sig → 128 hex chars
    expect(verifyNostrSig(sig, CANONICAL, PUB_A)).toBe(true);
  });

  it('rejects verification with the wrong public key', () => {
    const sig = signNostrAttestation(CANONICAL, PRIV_A);
    expect(verifyNostrSig(sig, CANONICAL, PUB_B)).toBe(false);
  });

  it('rejects a tampered canonical payload', () => {
    const sig = signNostrAttestation(CANONICAL, PRIV_A);
    const tampered = CANONICAL.replace('"purpose":"buzz-workspace-participation"', '"purpose":"evil"');
    expect(verifyNostrSig(sig, tampered, PUB_A)).toBe(false);
  });

  it('rejects a truncated / malformed signature', () => {
    expect(verifyNostrSig('deadbeef', CANONICAL, PUB_A)).toBe(false);
  });

  it('rejects an all-zero signature', () => {
    const zeroSig = '0'.repeat(128);
    expect(verifyNostrSig(zeroSig, CANONICAL, PUB_A)).toBe(false);
  });

  it('rejects an empty string signature', () => {
    expect(verifyNostrSig('', CANONICAL, PUB_A)).toBe(false);
  });

  it('keys A and B produce different signatures over the same payload', () => {
    const sigA = signNostrAttestation(CANONICAL, PRIV_A);
    const sigB = signNostrAttestation(CANONICAL, PRIV_B);
    expect(sigA).not.toBe(sigB);
    expect(verifyNostrSig(sigA, CANONICAL, PUB_A)).toBe(true);
    expect(verifyNostrSig(sigB, CANONICAL, PUB_B)).toBe(true);
    // Cross-key: each sig should fail against the other key
    expect(verifyNostrSig(sigA, CANONICAL, PUB_B)).toBe(false);
    expect(verifyNostrSig(sigB, CANONICAL, PUB_A)).toBe(false);
  });
});

describe('getNostrPublicKey', () => {
  it('returns a 64-char hex string (32-byte x-only key)', () => {
    const pub = getNostrPublicKey(PRIV_A);
    expect(pub).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(pub)).toBe(true);
  });

  it('is deterministic', () => {
    expect(getNostrPublicKey(PRIV_A)).toBe(getNostrPublicKey(PRIV_A));
  });

  it('produces different keys for different private keys', () => {
    expect(getNostrPublicKey(PRIV_A)).not.toBe(getNostrPublicKey(PRIV_B));
  });
});
