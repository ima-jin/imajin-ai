/**
 * The `mjn` reactor (#2016): posts `unit: 'MJNx'` to `/api/emission` (never
 * `currency: 'MJN'`, the pre-#2016 mislabeling), and forwards
 * `event.payload.attestationId` — stashed there by the `attestation`
 * reactor when it runs first with `await: true` in the same chain (see
 * `packages/bus/src/config.ts`) — as `metadata.attestation_id`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BusEvent } from '../src/types';

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'identity.created',
    issuer: 'did:imajin:issuer',
    subject: 'did:imajin:subject',
    scope: 'auth',
    payload: {},
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
  // mjn.ts reads PAY_SERVICE_URL/PAY_SERVICE_API_KEY at module load time, so
  // the env vars must be set BEFORE the dynamic import below resolves.
  process.env.PAY_SERVICE_URL = 'https://pay.kernel.test';
  process.env.PAY_SERVICE_API_KEY = 'test-key';
});

describe('mjnReactor — unit MJNx, never currency MJN (#2016)', () => {
  it('posts unit: MJNx to /api/emission for a plain fixed-amount rule', async () => {
    const { mjnReactor } = await import('../src/reactors/mjn');
    await mjnReactor(makeEvent(), { attestationType: 'identity.created' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://pay.kernel.test/api/emission');
    const body = JSON.parse(init.body as string);
    expect(body.unit).toBe('MJNx');
    expect(body.currency).toBeUndefined();
  });

  it('omits attestation_id from metadata when the event payload has none', async () => {
    const { mjnReactor } = await import('../src/reactors/mjn');
    await mjnReactor(makeEvent(), { attestationType: 'identity.created' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.metadata.attestation_id).toBeUndefined();
  });

  it('forwards event.payload.attestationId as metadata.attestation_id when present', async () => {
    const { mjnReactor } = await import('../src/reactors/mjn');
    await mjnReactor(
      makeEvent({ payload: { attestationId: 'att_from_reactor' } }),
      { attestationType: 'identity.created' },
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.metadata.attestation_id).toBe('att_from_reactor');
  });

  it('does nothing for an attestation type with no emission schedule entry', async () => {
    const { mjnReactor } = await import('../src/reactors/mjn');
    await mjnReactor(makeEvent({ type: 'not.a.real.type' }), { attestationType: 'not.a.real.type' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
