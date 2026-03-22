import { describe, it, expect } from 'vitest';
import { computeCid, verifyCid, parseCid } from '../src/index';

describe('computeCid', () => {
  it('produces a deterministic CID for the same object', async () => {
    const obj = { type: 'test', value: 42 };
    const cid1 = await computeCid(obj);
    const cid2 = await computeCid(obj);
    expect(cid1).toBe(cid2);
  });

  it('produces different CIDs for different objects', async () => {
    const cid1 = await computeCid({ a: 1 });
    const cid2 = await computeCid({ a: 2 });
    expect(cid1).not.toBe(cid2);
  });

  it('is key-order independent (dag-cbor canonical)', async () => {
    const cid1 = await computeCid({ b: 2, a: 1 });
    const cid2 = await computeCid({ a: 1, b: 2 });
    expect(cid1).toBe(cid2);
  });

  it('produces a CIDv1 string', async () => {
    const cid = await computeCid({ hello: 'world' });
    expect(cid).toMatch(/^b[a-z2-7]+$/); // base32lower
  });

  it('handles nested objects', async () => {
    const obj = {
      issuerDid: 'did:imajin:alice',
      payload: { role: 'attendee', nested: { deep: true } },
    };
    const cid = await computeCid(obj);
    expect(cid).toBeTruthy();
    expect(await verifyCid(obj, cid)).toBe(true);
  });

  it('handles arrays', async () => {
    const cid = await computeCid({ tags: ['a', 'b', 'c'] });
    expect(cid).toBeTruthy();
  });
});

describe('verifyCid', () => {
  it('returns true for matching object', async () => {
    const obj = { type: 'attestation', subject: 'did:imajin:test' };
    const cid = await computeCid(obj);
    expect(await verifyCid(obj, cid)).toBe(true);
  });

  it('returns false for tampered object', async () => {
    const obj = { type: 'attestation', subject: 'did:imajin:test' };
    const cid = await computeCid(obj);
    expect(await verifyCid({ ...obj, subject: 'did:imajin:tampered' }, cid)).toBe(false);
  });

  it('returns false for wrong CID', async () => {
    const obj = { type: 'test' };
    expect(await verifyCid(obj, 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });
});

describe('parseCid', () => {
  it('roundtrips through parse', async () => {
    const cid = await computeCid({ test: true });
    const parsed = parseCid(cid);
    expect(parsed.toString()).toBe(cid);
    expect(parsed.version).toBe(1);
  });
});
