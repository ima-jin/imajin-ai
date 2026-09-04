/**
 * Tests for emitSessionAttestation (#1822).
 *
 * The actual signing/insert mechanics now live in the shared
 * `emitMechanicalAttestation` primitive (see
 * emit-mechanical-attestation.test.ts for that coverage, including the
 * missing-key / missing-node-DID / non-fatal-failure cases) — this only
 * verifies emitSessionAttestation calls it with the right `session.created`
 * shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ emitMechanicalAttestation: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../emit-mechanical-attestation', () => ({
  emitMechanicalAttestation: mocks.emitMechanicalAttestation,
}));

import { emitSessionAttestation } from '../emit-session-attestation';

const SUBJECT_DID = 'did:imajin:veteze';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emitSessionAttestation (#1822)', () => {
  it('delegates to emitMechanicalAttestation with the session.created shape', async () => {
    await emitSessionAttestation({ did: SUBJECT_DID, method: 'keypair', tier: 'established', userAgent: 'iPhone' });

    expect(mocks.emitMechanicalAttestation).toHaveBeenCalledWith({
      subjectDid: SUBJECT_DID,
      type: 'session.created',
      contextId: null,
      contextType: 'auth',
      payload: { method: 'keypair', tier: 'established', user_agent_class: 'mobile' },
    });
  });

  it('classifies an unrecognized/missing user agent as unknown', async () => {
    await emitSessionAttestation({ did: SUBJECT_DID, method: 'keypair', tier: 'established' });

    const call = mocks.emitMechanicalAttestation.mock.calls[0][0];
    expect(call.payload.user_agent_class).toBe('unknown');
  });
});
