/**
 * `emitAttestation()` (#1820) — verifies `pending` and `originUrl` are
 * threaded into the POST body sent to the internal attestations route.
 * Both are optional and, when omitted, simply aren't present on the body
 * (the internal route defaults `pendingSignature` to false server-side).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { emitAttestation } from '../src/emit-attestation';

const AUTH_SERVICE_URL = 'https://auth.kernel.test';
const INTERNAL_API_KEY = 'internal-key';

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    issuer_did: 'did:imajin:supplier',
    subject_did: 'did:imajin:recipient',
    type: 'supply.received',
    context_id: 'lot_1',
    context_type: 'supply',
    ...overrides,
  };
}

function internalRouteBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]: [string]) => url.endsWith('/api/attestations/internal'));
  return JSON.parse(call![1].body as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  process.env.AUTH_INTERNAL_API_KEY = INTERNAL_API_KEY;
});

describe('emitAttestation pending/originUrl threading (#1820)', () => {
  it('includes pending: true in the internal route request body when passed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issuedAt: 'now' }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await emitAttestation(baseParams({ pending: true }));

    expect(internalRouteBody(fetchMock).pending).toBe(true);
  });

  it('includes originUrl in the internal route request body when passed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issuedAt: 'now' }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await emitAttestation(baseParams({ originUrl: 'https://xprize.example.com' }));

    expect(internalRouteBody(fetchMock).originUrl).toBe('https://xprize.example.com');
  });

  it('omits pending and originUrl from the body when the caller does not supply them', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ issuedAt: 'now' }), { status: 201 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await emitAttestation(baseParams());

    const body = internalRouteBody(fetchMock);
    expect(body.pending).toBeUndefined();
    expect(body.originUrl).toBeUndefined();
  });
});
