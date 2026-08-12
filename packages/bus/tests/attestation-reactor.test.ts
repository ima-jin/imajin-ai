/**
 * The `attestation` reactor (#1820) — threads `config.pending` and any
 * `event.payload.originUrl` through to `emitAttestation()`. Both default to
 * false/undefined so the many event types configured with `{ type: 'attestation' }`
 * (identity, vouch, ticket receipts, etc.) keep creating non-bilateral
 * attestations unless a chain config explicitly opts in (e.g. `supply.received`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmitAttestation } = vi.hoisted(() => ({
  mockEmitAttestation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/auth', () => ({ emitAttestation: mockEmitAttestation }));

import { attestationReactor } from '../src/reactors/attestation';
import type { BusEvent } from '../src/types';

const ISSUER = 'did:imajin:scott';
const SUBJECT = 'did:imajin:david';

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'supply.received',
    issuer: ISSUER,
    subject: SUBJECT,
    scope: 'supply',
    payload: { context_id: 'lot_1', context_type: 'supply' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitAttestation.mockResolvedValue(undefined);
});

describe('attestationReactor pending/originUrl threading (#1820)', () => {
  it('passes pending: true through to emitAttestation when config.pending is true', async () => {
    await attestationReactor(makeEvent(), { attestationType: 'supply.received', pending: true });

    expect(mockEmitAttestation).toHaveBeenCalledTimes(1);
    const params = mockEmitAttestation.mock.calls[0][0];
    expect(params.pending).toBe(true);
    expect(params.issuer_did).toBe(ISSUER);
    expect(params.subject_did).toBe(SUBJECT);
  });

  it('defaults pending to false when config omits it (one-shot system attestations)', async () => {
    await attestationReactor(makeEvent({ type: 'identity.created' }), { attestationType: 'identity.created' });

    const params = mockEmitAttestation.mock.calls[0][0];
    expect(params.pending).toBe(false);
  });

  it('defaults pending to false for a non-boolean config value', async () => {
    await attestationReactor(makeEvent(), { attestationType: 'supply.received', pending: 'yes' });

    const params = mockEmitAttestation.mock.calls[0][0];
    expect(params.pending).toBe(false);
  });

  it('threads event.payload.originUrl through when present', async () => {
    await attestationReactor(
      makeEvent({ payload: { context_id: 'lot_1', context_type: 'supply', originUrl: 'https://xprize.example.com' } }),
      { attestationType: 'supply.received', pending: true },
    );

    const params = mockEmitAttestation.mock.calls[0][0];
    expect(params.originUrl).toBe('https://xprize.example.com');
  });

  it('omits originUrl when not present on the event payload', async () => {
    await attestationReactor(makeEvent(), { attestationType: 'supply.received', pending: true });

    const params = mockEmitAttestation.mock.calls[0][0];
    expect(params.originUrl).toBeUndefined();
  });
});
