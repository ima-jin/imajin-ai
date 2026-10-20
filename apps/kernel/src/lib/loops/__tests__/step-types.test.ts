import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLoopIngestRequest } from '../types';
import { STEP_EVENT_TYPES, validateStepPayload } from '../step-types';
import { CODE_STEP, STEP_CLAIM, STEP_ISSUE, STEP_NOW, STEP_PRINCIPAL, STEP_ISSUE_UPDATE, queuedStep, stepEvent } from './horizon-fixtures';

function wire(event = queuedStep()) {
  return { type: event.type, payload: event.payload, publisherDid: event.issuer,
    signature: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(STEP_NOW); });
afterEach(() => vi.useRealTimers());

describe('step wire validation', () => {
  it('retains exact signed queue bytes and fields without inserting defaults', () => {
    const request = wire();
    const parsed = parseLoopIngestRequest(request);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.payload).toBe(request.payload);
  });
  it('accepts the exact signed ref-only update without inventing an OUTCOME', () => {
    const request = wire(stepEvent('step.updated', 1, { update: { issue: { ref: STEP_ISSUE } } }));
    const signedPayload = JSON.stringify(request.payload);
    const parsed = parseLoopIngestRequest(request);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.payload).toBe(request.payload);
    expect(parsed.value.payload.update).toEqual({ issue: { ref: STEP_ISSUE } });
    expect(JSON.stringify(parsed.value.payload)).toBe(signedPayload);
    expect((parsed.value.payload.update as { issue: object }).issue).not.toHaveProperty('outcome');
  });
  it.each(['OUTCOME', 'OUTCOME · Real declared result', 'OUTCOME: Real declared result\nMore detail'])(
    'preserves an explicitly supplied valid outcome verbatim: %s', outcome => {
      const request = wire(stepEvent('step.updated', 1, { update: { issue: { ref: STEP_ISSUE, outcome } } }));
      const parsed = parseLoopIngestRequest(request);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.value.payload).toBe(request.payload);
      expect(parsed.value.payload.update).toEqual({ issue: { ref: STEP_ISSUE, outcome } });
    },
  );
  it.each(['', ' ', 'not an OUTCOME', 'outcome · wrong case', 'OUTCOMES are not the prefix', 'OUTCOME_invalid', null, 42])(
    'rejects a malformed optional outcome when supplied: %j', outcome => {
      const request = wire(stepEvent('step.updated', 1, { update: { issue: { ref: STEP_ISSUE, outcome } } }));
      expect(parseLoopIngestRequest(request).ok).toBe(false);
    },
  );
  it.each([{}, { ref: '' }, { ref: ' ' }, { ref: null }, { ref: STEP_ISSUE, invented: true }])(
    'still requires a non-empty ref and rejects unknown issue fields: %j', issue => {
      expect(parseLoopIngestRequest(wire(stepEvent('step.updated', 1, { update: { issue } }))).ok).toBe(false);
    },
  );
  it.each(STEP_EVENT_TYPES)('recognizes signed %s events', type => {
    const extras: Partial<Record<typeof type, Record<string, unknown>>> = {
      'step.queued': { step: CODE_STEP }, 'step.updated': { update: STEP_ISSUE_UPDATE },
      'step.claimed': { claim: STEP_CLAIM },
      'step.observed': { observation: { conditionId: 'closed', evidence: { kind: 'issue_closed', issue: 'o/r#1' } } },
      'step.attested': { attestation: { conditionId: 'manual', did: STEP_PRINCIPAL, statement: 'Completed by me' } },
    };
    expect(parseLoopIngestRequest(wire(stepEvent(type, 0, extras[type]))).ok).toBe(true);
  });
  it.each([
    { zone: 'head' }, { depth: 12 }, { state: 'exited' }, { stepId: '' }, { stepId: '  ' },
    { output: { kind: 'text', text: 'No output on step facts' } },
    { step: { ...CODE_STEP, zone: 'done' } }, { step: { ...CODE_STEP, rank: Infinity } },
    { step: { ...CODE_STEP, repository: undefined } }, { step: { ...CODE_STEP, repository: 'bad' } },
    { step: { ...CODE_STEP, exitConditions: [] } }, { step: { ...CODE_STEP, exitConditions: CODE_STEP.exitConditions.slice(0, 2) } },
    { step: { ...CODE_STEP, exitConditions: [CODE_STEP.exitConditions[0], CODE_STEP.exitConditions[0], CODE_STEP.exitConditions[2]] } },
    { state: 'finished' },
  ])('rejects invalid declarations or authored projection data: %j', fields => {
    expect(parseLoopIngestRequest(wire(stepEvent('step.queued', 0, { step: CODE_STEP, ...fields }))).ok).toBe(false);
  });
  it.each([
    {}, { zone: 'near' }, { issue: { ref: 'o/r#1', outcome: '' } }, { issue: { ref: 'o/r#1', outcome: 'no outcome line' } },
    { exitConditions: [] }, { rank: 'first' }, { provisionRef: null },
  ])('rejects malformed sharpening and declaration rewrites: %j', update => {
    expect(validateStepPayload('step.updated', stepEvent('step.updated', 0, { update }).payload, STEP_PRINCIPAL)).toBe(false);
  });
  it('rejects forged manual attestor and claim holder DIDs', () => {
    expect(parseLoopIngestRequest(wire(stepEvent('step.attested', 0, { attestation: { conditionId: 'x', did: 'did:imajin:other', statement: 'I did it' } }))).ok).toBe(false);
    expect(parseLoopIngestRequest(wire(stepEvent('step.claimed', 0, { claim: { ...STEP_CLAIM, holderDid: 'did:imajin:other' } }))).ok).toBe(false);
  });
  it('rejects mixed event data and non-production deployment assertions', () => {
    expect(parseLoopIngestRequest(wire(stepEvent('step.updated', 0, { update: STEP_ISSUE_UPDATE, claim: STEP_CLAIM }))).ok).toBe(false);
    const observation = { conditionId: 'prod', evidence: { kind: 'deployed', repository: 'o/r', tag: 'v1', environment: 'dev' } };
    expect(parseLoopIngestRequest(wire(stepEvent('step.observed', 0, { observation }))).ok).toBe(false);
  });
});
