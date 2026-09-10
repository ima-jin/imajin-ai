/**
 * The `attestation` reactor (#1820) — threads `config.pending` and any
 * `event.payload.originUrl` through to `emitAttestation()`. Both default to
 * false/undefined so the many event types configured with `{ type: 'attestation' }`
 * (identity, vouch, ticket receipts, etc.) keep creating non-bilateral
 * attestations unless a chain config explicitly opts in (e.g. `supply.received`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmitAttestation } = vi.hoisted(() => ({
  mockEmitAttestation: vi.fn().mockResolvedValue({}),
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
  mockEmitAttestation.mockResolvedValue({});
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

describe('attestationReactor attestationId passthrough (#2016)', () => {
  it('stashes the created attestation id onto the shared event.payload for a later reactor (e.g. mjn) to read', async () => {
    mockEmitAttestation.mockResolvedValue({ attestationId: 'att_123' });
    const event = makeEvent();

    await attestationReactor(event, { attestationType: 'identity.created' });

    expect(event.payload).toMatchObject({ attestationId: 'att_123' });
  });

  it('leaves event.payload untouched when emitAttestation returns no id (e.g. attestation forwarding is disabled)', async () => {
    mockEmitAttestation.mockResolvedValue({});
    const event = makeEvent();
    const originalPayload = event.payload;

    await attestationReactor(event, { attestationType: 'identity.created' });

    expect(event.payload).toBe(originalPayload);
  });
});
