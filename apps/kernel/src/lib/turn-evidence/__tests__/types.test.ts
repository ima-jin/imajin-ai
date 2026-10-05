import { describe, it, expect } from 'vitest';
import { TURN_EVIDENCE_MAX_BATCH } from '@imajin/auth';
import { parseTurnEvidenceBatch } from '../types';
import { AGENT_DID, PRINCIPAL_DID, TURN_EVENT_ID, CLAIM_HASH, signedItem, wireBody } from './helpers';

function rawItems(count: number) {
  return wireBody(Array.from({ length: count }, (_, seq) => signedItem(seq))).evidence;
}

describe('parseTurnEvidenceBatch', () => {
  it('parses a valid multi-item batch and lifts the shared turn fields', () => {
    const result = parseTurnEvidenceBatch({ evidence: rawItems(3) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.turnEventId).toBe(TURN_EVENT_ID);
      expect(result.value.turnOutputHash).toBe(CLAIM_HASH);
      expect(result.value.agentDid).toBe(AGENT_DID);
      expect(result.value.principalDid).toBe(PRINCIPAL_DID);
      expect(result.value.items.map((item) => item.payload.seq)).toEqual([0, 1, 2]);
    }
  });

  it('lowercases the signature hex', () => {
    const [first] = rawItems(1);
    const result = parseTurnEvidenceBatch({ evidence: [{ ...first, signature: first.signature.toUpperCase() }] });
    expect(result.ok && result.value.items[0].signature).toBe(first.signature);
  });

  it.each([
    ['null body', null],
    ['array body', []],
    ['missing evidence', {}],
    ['empty evidence', { evidence: [] }],
    ['non-array evidence', { evidence: 'x' }],
  ])('rejects %s', (_label, body) => {
    expect(parseTurnEvidenceBatch(body).ok).toBe(false);
  });

  it(`rejects more than ${TURN_EVIDENCE_MAX_BATCH} items`, () => {
    const result = parseTurnEvidenceBatch({ evidence: rawItems(TURN_EVIDENCE_MAX_BATCH + 1) });
    expect(result).toEqual({ ok: false, error: `evidence may hold at most ${TURN_EVIDENCE_MAX_BATCH} items per batch` });
  });

  it('accepts exactly the maximum batch size', () => {
    expect(parseTurnEvidenceBatch({ evidence: rawItems(TURN_EVIDENCE_MAX_BATCH) }).ok).toBe(true);
  });

  it('names the failing item and field for an invalid payload, never echoing values', () => {
    const [first, second] = rawItems(2);
    const result = parseTurnEvidenceBatch({
      evidence: [first, { ...second, payload: { ...second.payload, secretArgs: 'sk-live-xyz' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('evidence[1]');
      expect(result.error).toContain('secretArgs');
      expect(result.error).not.toContain('sk-live-xyz');
    }
  });

  it.each([
    ['non-object item', 'nope', 'evidence[0] must be an object'],
    ['array item', [], 'evidence[0] must be an object'],
  ])('rejects a %s', (_label, item, error) => {
    expect(parseTurnEvidenceBatch({ evidence: [item] })).toEqual({ ok: false, error });
  });

  it.each([
    ['missing issued_at', { issued_at: undefined }, 'issued_at must be a Unix epoch milliseconds integer'],
    ['fractional issued_at', { issued_at: 1.5 }, 'issued_at must be a Unix epoch milliseconds integer'],
    ['zero issued_at', { issued_at: 0 }, 'issued_at must be a Unix epoch milliseconds integer'],
    ['far-future issued_at', { issued_at: Date.now() + 24 * 3_600_000 }, 'issued_at is in the future'],
    ['missing signature', { signature: undefined }, 'signature must be a 128-char hex Ed25519 signature'],
    ['short signature', { signature: 'abcd' }, 'signature must be a 128-char hex Ed25519 signature'],
    ['non-hex signature', { signature: 'z'.repeat(128) }, 'signature must be a 128-char hex Ed25519 signature'],
  ])('rejects %s', (_label, override, message) => {
    const [first] = rawItems(1);
    const result = parseTurnEvidenceBatch({ evidence: [{ ...first, ...override }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it('rejects items that disagree about the turn, hash, agent or principal', () => {
    const base = rawItems(1)[0];
    const other = wireBody([signedItem(1, { turnEventId: 'turn_evt_other' })]).evidence[0];
    expect(parseTurnEvidenceBatch({ evidence: [base, other] }).ok).toBe(false);

    const otherAgent = wireBody([signedItem(1, { agentDid: 'did:imajin:someone-else' })]).evidence[0];
    expect(parseTurnEvidenceBatch({ evidence: [base, otherAgent] }).ok).toBe(false);

    const otherPrincipal = wireBody([signedItem(1, { principalDid: 'did:imajin:someone-else' })]).evidence[0];
    expect(parseTurnEvidenceBatch({ evidence: [base, otherPrincipal] }).ok).toBe(false);

    const otherClaim = wireBody([signedItem(1, { turnOutputHash: `sha256:${'0'.repeat(64)}` })]).evidence[0];
    const result = parseTurnEvidenceBatch({ evidence: [base, otherClaim] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('evidence[1] names a different turn');
  });

  it('rejects duplicate seq within a batch', () => {
    const [first] = rawItems(1);
    const result = parseTurnEvidenceBatch({ evidence: [first, first] });
    expect(result).toEqual({ ok: false, error: 'evidence[1].seq duplicates another item in the batch' });
  });
});
