import { describe, it, expect } from 'vitest';
import { sign, signSync, canonicalize, createChallenge } from '../src/sign';
import { generateKeypair } from '../src/crypto';

describe('canonicalize', () => {
  it('sorts object keys alphabetically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces identical output regardless of insertion order', () => {
    const a = canonicalize({ z: 1, a: 2, m: 3 });
    const b = canonicalize({ a: 2, z: 1, m: 3 });
    expect(a).toBe(b);
  });

  it('handles nested objects with sorted keys', () => {
    const result = canonicalize({ b: { d: 1, c: 2 }, a: 3 });
    expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('handles arrays (preserves order)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null', () => {
    expect(canonicalize(null)).toBe('null');
  });

  it('handles undefined', () => {
    expect(canonicalize(undefined)).toBe('undefined');
  });

  it('handles strings', () => {
    expect(canonicalize('hello')).toBe('"hello"');
  });

  it('handles numbers', () => {
    expect(canonicalize(42)).toBe('42');
  });

  it('handles booleans', () => {
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });

  it('handles empty objects', () => {
    expect(canonicalize({})).toBe('{}');
  });

  it('handles empty arrays', () => {
    expect(canonicalize([])).toBe('[]');
  });
});

describe('sign / signSync', () => {
  const keypair = generateKeypair();
  const identity = { id: 'did:imajin:test123', type: 'human' as const };

  it('creates a signed message with correct structure', () => {
    const msg = signSync({ action: 'test' }, keypair.privateKey, identity);
    expect(msg.from).toBe('did:imajin:test123');
    expect(msg.type).toBe('human');
    expect(typeof msg.timestamp).toBe('number');
    expect(typeof msg.signature).toBe('string');
    expect(msg.signature).toHaveLength(128);
    expect(msg.payload).toEqual({ action: 'test' });
  });

  it('async sign produces same structure', async () => {
    const msg = await sign({ action: 'test' }, keypair.privateKey, identity);
    expect(msg.from).toBe('did:imajin:test123');
    expect(msg.signature).toHaveLength(128);
  });

  it('signs different payloads with different signatures', () => {
    const a = signSync({ n: 1 }, keypair.privateKey, identity);
    const b = signSync({ n: 2 }, keypair.privateKey, identity);
    expect(a.signature).not.toBe(b.signature);
  });

  it('timestamps are recent', () => {
    const before = Date.now();
    const msg = signSync({}, keypair.privateKey, identity);
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('createChallenge', () => {
  it('returns a 64-char hex string', () => {
    const challenge = createChallenge();
    expect(challenge).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(challenge)).toBe(true);
  });

  it('generates unique challenges', () => {
    const a = createChallenge();
    const b = createChallenge();
    expect(a).not.toBe(b);
  });
});
