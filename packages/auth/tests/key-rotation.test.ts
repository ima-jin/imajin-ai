import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '../src/types/attestation';
import * as crypto from '../src/crypto';
import {
  KEY_ROTATED_ATTESTATION_TYPE,
  buildKeyRotationStatement,
  computeKeyKid,
  createKeyRotatedPayload,
  evaluateKeyRotationPreflight,
  trustedPublicKeysAt,
  verifyKeyRotatedPayload,
  verifyKeyRotationChain,
  type KeyRotatedPayload,
} from '../src/key-rotation';

/** Fresh random keys per test run — no key material is committed. */
const newKeypair = () => crypto.generateKeypair();

function rotate(oldPrivateKey: string, newPrivateKey: string, effectiveAt: string): KeyRotatedPayload {
  return createKeyRotatedPayload({ oldPrivateKey, newPrivateKey, effectiveAt: new Date(effectiveAt) });
}

describe('key.rotated attestation type registration (#2081, closes that line of #513)', () => {
  it('is a known attestation type', () => {
    expect((ATTESTATION_TYPES as readonly string[]).includes('key.rotated')).toBe(true);
    expect(KEY_ROTATED_ATTESTATION_TYPE).toBe('key.rotated');
  });

  it('is mechanical (node-minted, never bilateral)', () => {
    expect((MECHANICAL_ATTESTATION_TYPES as readonly string[]).includes('key.rotated')).toBe(true);
  });

  it('is registered exactly once in each list', () => {
    expect(ATTESTATION_TYPES.filter((type) => type === 'key.rotated')).toHaveLength(1);
    expect(MECHANICAL_ATTESTATION_TYPES.filter((type) => type === 'key.rotated')).toHaveLength(1);
  });
});

describe('computeKeyKid', () => {
  it('matches the legacy sha256-of-hex kid the well-known document has always published', () => {
    const { publicKey } = newKeypair();
    const legacy = `auth-${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
    expect(computeKeyKid(publicKey)).toBe(legacy);
    expect(computeKeyKid(publicKey)).toMatch(/^auth-[0-9a-f]{16}$/);
  });

  it('differs for different keys', () => {
    expect(computeKeyKid(newKeypair().publicKey)).not.toBe(computeKeyKid(newKeypair().publicKey));
  });
});

describe('createKeyRotatedPayload', () => {
  it('names old/new kid and key, the effective instant, and carries both signatures', () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const payload = rotate(oldKey.privateKey, newKey.privateKey, '2026-10-06T12:00:00.000Z');

    expect(payload.oldKid).toBe(computeKeyKid(oldKey.publicKey));
    expect(payload.newKid).toBe(computeKeyKid(newKey.publicKey));
    expect(payload.oldPublicKey).toBe(oldKey.publicKey);
    expect(payload.newPublicKey).toBe(newKey.publicKey);
    expect(payload.effectiveAt).toBe('2026-10-06T12:00:00.000Z');

    const statement = buildKeyRotationStatement(payload);
    expect(crypto.verifySync(payload.oldKeySignature, statement, oldKey.publicKey)).toBe(true);
    expect(crypto.verifySync(payload.newKeySignature, statement, newKey.publicKey)).toBe(true);
  });

  it('never embeds private key material', () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const serialized = JSON.stringify(rotate(oldKey.privateKey, newKey.privateKey, '2026-10-06T12:00:00.000Z'));
    expect(serialized).not.toContain(oldKey.privateKey);
    expect(serialized).not.toContain(newKey.privateKey);
  });

  it('defaults effectiveAt to now', () => {
    const before = Date.now();
    const payload = createKeyRotatedPayload({
      oldPrivateKey: newKeypair().privateKey,
      newPrivateKey: newKeypair().privateKey,
    });
    expect(Date.parse(payload.effectiveAt)).toBeGreaterThanOrEqual(before);
  });

  it('accepts a PKCS#8-encoded key and derives the same public key as the raw seed', () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const pkcs8 = `302e020100300506032b657004220420${newKey.privateKey}`;
    const payload = rotate(oldKey.privateKey, pkcs8, '2026-10-06T12:00:00.000Z');
    expect(payload.newPublicKey).toBe(newKey.publicKey);
    expect(verifyKeyRotatedPayload(payload).ok).toBe(true);
  });

  it('refuses to rotate to the same key', () => {
    const key = newKeypair();
    expect(() => rotate(key.privateKey, key.privateKey, '2026-10-06T12:00:00.000Z')).toThrow(/identical/);
  });

  it('refuses invalid keys and an invalid date', () => {
    const key = newKeypair();
    expect(() => rotate('nope', key.privateKey, '2026-10-06T12:00:00.000Z')).toThrow(/old private key/);
    expect(() => rotate(key.privateKey, 'nope', '2026-10-06T12:00:00.000Z')).toThrow(/new private key/);
    expect(() =>
      createKeyRotatedPayload({
        oldPrivateKey: key.privateKey,
        newPrivateKey: newKeypair().privateKey,
        effectiveAt: new Date(Number.NaN),
      }),
    ).toThrow(/effectiveAt/);
  });
});

describe('verifyKeyRotatedPayload', () => {
  const oldKey = newKeypair();
  const newKey = newKeypair();
  const good = rotate(oldKey.privateKey, newKey.privateKey, '2026-10-06T12:00:00.000Z');

  it('accepts a genuine dual-signed payload', () => {
    const result = verifyKeyRotatedPayload(good);
    expect(result.ok).toBe(true);
  });

  it('rejects non-objects and missing fields', () => {
    expect(verifyKeyRotatedPayload(null).ok).toBe(false);
    expect(verifyKeyRotatedPayload([]).ok).toBe(false);
    expect(verifyKeyRotatedPayload('x').ok).toBe(false);
    const partial: Partial<KeyRotatedPayload> = { ...good };
    delete partial.newKeySignature;
    expect(verifyKeyRotatedPayload(partial)).toEqual({
      ok: false,
      error: 'key.rotated payload.newKeySignature must be a non-empty string',
    });
  });

  it('rejects when only the old key signed (new-key signature forged)', () => {
    const forged = { ...good, newKeySignature: good.oldKeySignature };
    expect(verifyKeyRotatedPayload(forged)).toEqual({
      ok: false,
      error: 'newKeySignature does not verify against the new public key',
    });
  });

  it('rejects when only the new key signed (old-key signature forged)', () => {
    const forged = { ...good, oldKeySignature: good.newKeySignature };
    expect(verifyKeyRotatedPayload(forged)).toEqual({
      ok: false,
      error: 'oldKeySignature does not verify against the old public key',
    });
  });

  it('rejects a handover forged with a stolen old key but without the successor key', () => {
    const attacker = newKeypair();
    // The thief holds the old key and names `attacker` as successor, but the
    // second signature comes from a key that is not the one the statement names.
    const statement = buildKeyRotationStatement({
      oldPublicKey: oldKey.publicKey,
      newPublicKey: attacker.publicKey,
      effectiveAt: '2026-10-06T12:00:00.000Z',
    });
    const forged: KeyRotatedPayload = {
      oldKid: computeKeyKid(oldKey.publicKey),
      newKid: computeKeyKid(attacker.publicKey),
      oldPublicKey: oldKey.publicKey,
      newPublicKey: attacker.publicKey,
      effectiveAt: '2026-10-06T12:00:00.000Z',
      oldKeySignature: crypto.signSync(statement, oldKey.privateKey),
      newKeySignature: crypto.signSync(statement, newKey.privateKey),
    };
    expect(verifyKeyRotatedPayload(forged).ok).toBe(false);
  });

  it('rejects tampering with any signed field', () => {
    const later = verifyKeyRotatedPayload({ ...good, effectiveAt: '2026-10-07T12:00:00.000Z' });
    expect(later.ok).toBe(false);
  });

  it('rejects a kid that does not hash the named public key', () => {
    expect(verifyKeyRotatedPayload({ ...good, oldKid: 'auth-0000000000000000' })).toEqual({
      ok: false,
      error: 'oldKid does not match oldPublicKey',
    });
    expect(verifyKeyRotatedPayload({ ...good, newKid: 'auth-0000000000000000' })).toEqual({
      ok: false,
      error: 'newKid does not match newPublicKey',
    });
  });

  it('rejects invalid public keys, same-key payloads and unparseable dates', () => {
    expect(verifyKeyRotatedPayload({ ...good, oldPublicKey: 'zz' }).ok).toBe(false);
    expect(verifyKeyRotatedPayload({ ...good, newPublicKey: good.oldPublicKey })).toEqual({
      ok: false,
      error: 'key.rotated payload names the same key as old and new',
    });
    expect(verifyKeyRotatedPayload({ ...good, effectiveAt: 'not-a-date' })).toEqual({
      ok: false,
      error: 'effectiveAt is not a valid ISO-8601 instant',
    });
  });
});

describe('verifyKeyRotationChain', () => {
  const k0 = newKeypair();
  const k1 = newKeypair();
  const k2 = newKeypair();
  const r1 = rotate(k0.privateKey, k1.privateKey, '2026-03-01T00:00:00.000Z');
  const r2 = rotate(k1.privateKey, k2.privateKey, '2026-09-01T00:00:00.000Z');

  it('treats no rotations as a valid empty history', () => {
    expect(verifyKeyRotationChain([])).toEqual({ ok: true, keys: [], currentKid: null });
  });

  it('builds a linear history regardless of input order', () => {
    const result = verifyKeyRotationChain([r2, r1], { anchorPublicKey: k0.publicKey });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keys.map((key) => key.publicKey)).toEqual([k0.publicKey, k1.publicKey, k2.publicKey]);
    expect(result.currentKid).toBe(computeKeyKid(k2.publicKey));
    expect(result.keys[0]).toMatchObject({ validFrom: null, validUntil: r1.effectiveAt });
    expect(result.keys[1]).toMatchObject({ validFrom: r1.effectiveAt, validUntil: r2.effectiveAt });
    expect(result.keys[2]).toMatchObject({ validFrom: r2.effectiveAt, validUntil: null });
  });

  it('rejects a chain that does not start at the pinned anchor', () => {
    expect(verifyKeyRotationChain([r1, r2], { anchorPublicKey: k1.publicKey })).toEqual({
      ok: false,
      error: 'key history does not start at the pinned anchor key',
    });
  });

  it('reports which payload failed verification', () => {
    const result = verifyKeyRotationChain([r1, { ...r2, oldKeySignature: r2.newKeySignature }]);
    expect(result).toMatchObject({ ok: false, index: 1 });
  });

  it('rejects a fork (two successors of the same key)', () => {
    const fork = rotate(k0.privateKey, newKeypair().privateKey, '2026-04-01T00:00:00.000Z');
    const result = verifyKeyRotationChain([r1, fork]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/forks/);
  });

  it('rejects disconnected rotations', () => {
    const island = rotate(newKeypair().privateKey, newKeypair().privateKey, '2026-05-01T00:00:00.000Z');
    const result = verifyKeyRotationChain([r1, island]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/single starting key/);
  });

  it('rejects a cycle back to a retired key', () => {
    const back = rotate(k2.privateKey, k0.privateKey, '2026-10-01T00:00:00.000Z');
    const result = verifyKeyRotationChain([r1, r2, back]);
    expect(result.ok).toBe(false);
  });

  it('rejects a reuse of a retired key without a full cycle', () => {
    // k0 -> k1 -> k2 -> k1: the last link re-introduces k1.
    const reuse = rotate(k2.privateKey, k1.privateKey, '2026-10-01T00:00:00.000Z');
    expect(verifyKeyRotationChain([r1, r2, reuse]).ok).toBe(false);
  });

  it('rejects a rotation dated before the one that introduced its old key', () => {
    const early = rotate(k1.privateKey, k2.privateKey, '2026-01-01T00:00:00.000Z');
    const result = verifyKeyRotationChain([r1, early]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/takes effect before/);
  });
});

describe('trustedPublicKeysAt', () => {
  const k0 = newKeypair();
  const k1 = newKeypair();
  const k2 = newKeypair();
  const chain = verifyKeyRotationChain([
    rotate(k0.privateKey, k1.privateKey, '2026-03-01T00:00:00.000Z'),
    rotate(k1.privateKey, k2.privateKey, '2026-09-01T00:00:00.000Z'),
  ]);
  const history = chain.ok ? chain.keys : [];

  it('resolves the key that was signing at a given instant', () => {
    expect(trustedPublicKeysAt(history, new Date('2026-01-01T00:00:00.000Z'))).toEqual([k0.publicKey]);
    expect(trustedPublicKeysAt(history, new Date('2026-05-01T00:00:00.000Z'))).toEqual([k1.publicKey]);
    expect(trustedPublicKeysAt(history, Date.parse('2026-12-01T00:00:00.000Z'))).toEqual([k2.publicKey]);
  });

  it('switches exactly at effectiveAt (inclusive for the new key, exclusive for the old)', () => {
    expect(trustedPublicKeysAt(history, new Date('2026-03-01T00:00:00.000Z'))).toEqual([k1.publicKey]);
    expect(trustedPublicKeysAt(history, new Date('2026-02-28T23:59:59.999Z'))).toEqual([k0.publicKey]);
  });

  it('returns nothing for an empty history', () => {
    expect(trustedPublicKeysAt([], new Date())).toEqual([]);
  });
});

describe('evaluateKeyRotationPreflight', () => {
  const NOW = new Date('2026-10-06T00:00:00.000Z');

  it('passes a real rotation and emits the grace-window env values (public key only)', () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const result = evaluateKeyRotationPreflight({
      oldPrivateKey: oldKey.privateKey,
      newPrivateKey: newKey.privateKey,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.oldKey).toEqual({ kid: computeKeyKid(oldKey.publicKey), publicKey: oldKey.publicKey });
    expect(result.newKey).toEqual({ kid: computeKeyKid(newKey.publicKey), publicKey: newKey.publicKey });
    expect(result.previousKeyEnv).toEqual({
      AUTH_PREVIOUS_PUBLIC_KEY: oldKey.publicKey,
      AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM: '2026-10-06T00:00:00.000Z',
      AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL: '2026-10-08T00:00:00.000Z',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(oldKey.privateKey);
    expect(serialized).not.toContain(newKey.privateKey);
  });

  it('honours a custom grace window', () => {
    const result = evaluateKeyRotationPreflight({
      oldPrivateKey: newKeypair().privateKey,
      newPrivateKey: newKeypair().privateKey,
      graceHours: 72,
      now: NOW,
    });
    expect(result.previousKeyEnv?.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL).toBe('2026-10-09T00:00:00.000Z');
  });

  it('fails when either key is missing or malformed', () => {
    const missing = evaluateKeyRotationPreflight({});
    expect(missing.ok).toBe(false);
    expect(missing.errors).toEqual(['old key is not set', 'new key is not set']);
    expect(missing.previousKeyEnv).toBeUndefined();

    const malformed = evaluateKeyRotationPreflight({ oldPrivateKey: 'abc', newPrivateKey: newKeypair().privateKey });
    expect(malformed.ok).toBe(false);
    expect(malformed.errors[0]).toMatch(/old key is not a valid Ed25519 private key/);
  });

  it('fails when the new key equals the old key', () => {
    const key = newKeypair();
    const result = evaluateKeyRotationPreflight({ oldPrivateKey: key.privateKey, newPrivateKey: key.privateKey });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('new key is identical to the old key — nothing to rotate');
  });

  it('fails when the new key is the publicly-known dev fallback (#1520)', () => {
    const devSeed = createHash('sha256').update('dev-vault-signing-key-imajin').digest('hex');
    const result = evaluateKeyRotationPreflight({
      oldPrivateKey: newKeypair().privateKey,
      newPrivateKey: devSeed,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/dev fallback key/);
  });

  it('fails on a non-positive grace window and warns on a short one', () => {
    const base = { oldPrivateKey: newKeypair().privateKey, newPrivateKey: newKeypair().privateKey };
    expect(evaluateKeyRotationPreflight({ ...base, graceHours: 0 }).ok).toBe(false);
    expect(evaluateKeyRotationPreflight({ ...base, graceHours: Number.NaN }).ok).toBe(false);

    const short = evaluateKeyRotationPreflight({ ...base, graceHours: 2, now: NOW });
    expect(short.ok).toBe(true);
    expect(short.warnings).toHaveLength(1);
    expect(short.warnings[0]).toMatch(/shorter than 24h/);
  });
});
