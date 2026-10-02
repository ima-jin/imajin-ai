/**
 * publish() hands back the id of the attestation minted by an awaited
 * `attestation` reactor in the event's chain (#2444) — the mechanism behind
 * `POST /api/apps/claim` returning the `apps.signing-key.claimed` attestation
 * id. The reactor itself stashes the id onto the shared event payload (see
 * reactors/attestation.ts); publish() reads it back after the chain has run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Empty rows -> chain resolution falls back to the hardcoded DEFAULTS map.
const { fakeSql } = vi.hoisted(() => ({
  fakeSql: (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
}));
vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

const { attestationHandler, emitHandler } = vi.hoisted(() => ({
  attestationHandler: vi.fn(),
  emitHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/registry', () => ({
  getReactor: (type: string) => {
    if (type === 'attestation') return attestationHandler;
    if (type === 'emit') return emitHandler;
    return undefined;
  },
}));

import { publish } from '../src/publish';

const CLAIMED_EVENT = {
  issuer: 'did:imajin:node',
  subject: 'did:imajin:app',
  scope: 'apps',
  payload: {
    slug: 'dykil',
    appDid: 'did:imajin:app',
    grantId: 'vdg_1',
    hostHint: null,
    context_id: 'did:imajin:app',
    context_type: 'apps.signing-key' as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publish() result (#2444)', () => {
  it('returns the attestation id the awaited attestation reactor stashed on the event', async () => {
    attestationHandler.mockImplementation(async (event: { payload?: Record<string, unknown> }) => {
      event.payload = { ...event.payload, attestationId: 'att_123' };
    });

    const result = await publish('apps.signing-key.claimed', CLAIMED_EVENT);

    expect(result).toEqual({ attestationId: 'att_123' });
    expect(attestationHandler).toHaveBeenCalledTimes(1);
    expect(attestationHandler.mock.calls[0][1]).toMatchObject({ attestationType: 'apps.signing-key.claimed' });
  });

  it('returns no attestation id when the reactor produced none (e.g. attestation forwarding disabled)', async () => {
    attestationHandler.mockResolvedValue(undefined);

    const result = await publish('apps.signing-key.claimed', CLAIMED_EVENT);

    expect(result).toEqual({});
  });

  it('returns an empty result for a chain with no attestation reactor', async () => {
    const result = await publish('session.created', {
      issuer: 'did:imajin:alice',
      subject: 'did:imajin:alice',
      scope: 'test-publish-result',
      payload: { tier: 'standard' },
    });

    expect(result).toEqual({});
    expect(attestationHandler).not.toHaveBeenCalled();
  });

  it('does not mutate the caller-supplied payload object', async () => {
    attestationHandler.mockImplementation(async (event: { payload?: Record<string, unknown> }) => {
      event.payload = { ...event.payload, attestationId: 'att_456' };
    });
    const payload = { ...CLAIMED_EVENT.payload };

    await publish('apps.signing-key.claimed', { ...CLAIMED_EVENT, payload });

    expect(payload).not.toHaveProperty('attestationId');
  });
});
