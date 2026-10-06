import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BusEvent } from '../src/types';

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock('@imajin/emit', () => ({ emit: emitMock }));
vi.mock('../src/publish', () => ({ publish: vi.fn(() => Promise.resolve({})) }));

import { emitReactor } from '../src/reactors/emit';
import { dfosReactor } from '../src/reactors/dfos';
import { auditReactor, auditRejection } from '../src/reactors/audit';
import { intersectionScopeReactor } from '../src/reactors/intersection-scope';
import { mutualReachConsentReactor } from '../src/reactors/mutual-reach-consent';

const event = {
  type: 'attestation.created',
  issuer: 'did:imajin:a',
  subject: 'did:imajin:b',
  scope: 'test',
  payload: {},
  timestamp: '2026-10-05T00:00:00.000Z',
} as unknown as BusEvent;

beforeEach(() => {
  emitMock.mockReset();
});

describe('emitReactor', () => {
  it('emits and resolves', async () => {
    await expect(emitReactor(event, {})).resolves.toBeUndefined();
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ service: 'test', did: 'did:imajin:a', status: 'success' }));
  });

  it('rejects (not throws) when emit throws synchronously', async () => {
    emitMock.mockImplementation(() => {
      throw new Error('emit failed');
    });
    let pending: Promise<void> | undefined;
    expect(() => { pending = emitReactor(event, {}); }).not.toThrow();
    await expect(pending).rejects.toThrow('emit failed');
  });
});

describe('dfosReactor', () => {
  it('resolves whether or not direct chain writes are enabled', async () => {
    await expect(dfosReactor(event, {})).resolves.toBeUndefined();
    await expect(dfosReactor(event, { directChainWrite: true })).resolves.toBeUndefined();
  });
});

const baseRequest = {
  requester: 'did:imajin:r',
  subject: 'did:imajin:s',
  fields: ['overlap_tags'],
  purpose: 'availability.match',
  scope: 'calendar',
};

describe('broker reactors keep their Promise contract', () => {
  it('auditReactor skips in preview mode and returns the state', async () => {
    const state = { request: { ...baseRequest, preview: true } } as never;
    await expect(auditReactor(state)).resolves.toBe(state);
  });

  it('auditReactor rejects (not throws) when the envelope is missing', async () => {
    const state = { request: { ...baseRequest } } as never;
    let pending: Promise<unknown> | undefined;
    expect(() => { pending = auditReactor(state); }).not.toThrow();
    await expect(pending).rejects.toThrow('envelope missing');
  });

  it('auditRejection resolves, skipping in preview mode', async () => {
    const result = { status: 'rejected', reason: 'no_consent', fields: [] } as never;
    await expect(auditRejection({ ...baseRequest, preview: true } as never, result)).resolves.toBeUndefined();
  });

  it('intersectionScopeReactor resolves with filtered data, or a rejection when no tags overlap', async () => {
    const ok = await intersectionScopeReactor({
      request: { ...baseRequest, data: { overlapTags: ['x', 1, 'y'], isSensitive: true, deliveryPolicy: 'named_nudge', arriverIntentId: 'a', candidateIntentId: 'b' } },
    } as never);
    expect(ok).toMatchObject({
      filteredData: { overlap_tags: ['x', 'y'], is_sensitive: true, delivery_policy: 'named_nudge', arriver_intent_id: 'a', candidate_intent_id: 'b' },
    });

    const none = await intersectionScopeReactor({ request: { ...baseRequest } } as never);
    expect(none).toMatchObject({ status: 'rejected', reason: 'no_consent' });
  });

  it('mutualReachConsentReactor grants when both admit, rejects otherwise', async () => {
    const granted = await mutualReachConsentReactor({
      request: { ...baseRequest, data: { arriverAdmitsCandidate: true, candidateAdmitsArriver: true, arriverIntentId: 'a', candidateIntentId: 'b' } },
    } as never);
    expect(granted).toMatchObject({ allowedFields: ['overlap_tags'], mode: 'attestation', consentReference: 'mutual-reach:a:b' });

    const denied = await mutualReachConsentReactor({
      request: { ...baseRequest, data: { arriverAdmitsCandidate: true, candidateAdmitsArriver: false } },
    } as never);
    expect(denied).toMatchObject({ status: 'rejected', reason: 'no_consent' });
  });
});
