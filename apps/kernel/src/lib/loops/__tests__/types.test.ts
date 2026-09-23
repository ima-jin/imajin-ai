import { describe, it, expect } from 'vitest';
import { parseLoopIngestRequest } from '../types';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    type: 'loop.started',
    payload: {
      loopId: 'loop_abc123',
      kind: 'warp.run',
      principal: 'did:imajin:ryan',
      state: 'queued',
      summary: 'Kicked off',
      at: new Date().toISOString(),
    },
    publisherDid: 'did:imajin:warp-node',
    signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) },
    ...overrides,
  };
}

describe('parseLoopIngestRequest', () => {
  it('accepts a well-formed request and normalizes keyId/sig casing', () => {
    const result = parseLoopIngestRequest(
      validBody({ signature: { keyId: 'A'.repeat(64), alg: 'ed25519', sig: 'B'.repeat(128) } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.signature).toEqual({ keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) });
    expect(result.value.payload.parentLoopId).toBeNull();
  });

  it('accepts optional parentLoopId and refs', () => {
    const result = parseLoopIngestRequest(
      validBody({
        payload: {
          ...validBody().payload,
          parentLoopId: 'loop_parent',
          refs: { issue: '2295', pr: '9001', runId: 'run_1', sessionKey: 'sess_1' },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.payload.parentLoopId).toBe('loop_parent');
    expect(result.value.payload.refs).toEqual({ issue: '2295', pr: '9001', runId: 'run_1', sessionKey: 'sess_1' });
  });

  it.each([
    { label: 'not an object', raw: 'nope' },
    { label: 'missing type', raw: (() => { const b = validBody() as Record<string, unknown>; delete b.type; return b; })() },
    { label: 'unknown type', raw: validBody({ type: 'loop.exploded' }) },
    { label: 'publisherDid not a DID', raw: validBody({ publisherDid: 'not-a-did' }) },
    { label: 'payload not an object', raw: validBody({ payload: 'nope' }) },
    { label: 'payload missing loopId', raw: validBody({ payload: { ...validBody().payload, loopId: undefined } }) },
    { label: 'payload principal not a DID', raw: validBody({ payload: { ...validBody().payload, principal: 'ryan' } }) },
    { label: 'payload.at not parseable', raw: validBody({ payload: { ...validBody().payload, at: 'yesterday' } }) },
    { label: 'payload.at far in the past (stale replay)', raw: validBody({ payload: { ...validBody().payload, at: '2000-01-01T00:00:00.000Z' } }) },
    { label: 'payload.at far in the future', raw: validBody({ payload: { ...validBody().payload, at: '2999-01-01T00:00:00.000Z' } }) },
    { label: 'payload.summary empty', raw: validBody({ payload: { ...validBody().payload, summary: '' } }) },
    { label: 'payload.refs unknown key', raw: validBody({ payload: { ...validBody().payload, refs: { bogus: '1' } } }) },
    { label: 'payload.refs non-string value', raw: validBody({ payload: { ...validBody().payload, refs: { issue: 123 } } }) },
    { label: 'signature.keyId too short', raw: validBody({ signature: { keyId: 'ab', alg: 'ed25519', sig: 'b'.repeat(128) } }) },
    { label: 'signature.alg wrong', raw: validBody({ signature: { keyId: 'a'.repeat(64), alg: 'secp256k1', sig: 'b'.repeat(128) } }) },
    { label: 'signature.sig wrong length', raw: validBody({ signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(64) } }) },
  ])('rejects $label', ({ raw }) => {
    const result = parseLoopIngestRequest(raw);
    expect(result.ok).toBe(false);
  });
});
