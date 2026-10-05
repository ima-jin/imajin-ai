/**
 * Tests for `POST /auth/api/attestations/turn-evidence` (#1978): the route's
 * own request/response wiring. Batch parsing (`parseTurnEvidenceBatch`) and
 * rate limiting run for real; `ingestTurnEvidence` (signature/authorization/
 * storage) is mocked here and covered end to end — with real signatures — in
 * `src/lib/turn-evidence/__tests__/`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INGEST_RATE_LIMIT } from '@/src/lib/turn-evidence/config';
import { signedItem, wireBody } from '@/src/lib/turn-evidence/__tests__/helpers';

const { mockIngest } = vi.hoisted(() => ({ mockIngest: vi.fn() }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'access-control-allow-origin': '*' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/turn-evidence/ingest', () => ({ ingestTurnEvidence: mockIngest }));
vi.mock('@/src/lib/turn-evidence/ingest-deps', () => ({ productionIngestDeps: { marker: 'deps' } }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST, OPTIONS } from '../route';

let ipCounter = 0;
function post(body: unknown, ip = `203.0.113.${++ipCounter}`): Request {
  return new Request('https://test.imajin.ai/auth/api/attestations/turn-evidence', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const valid = () => wireBody([signedItem(0), signedItem(1)]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/attestations/turn-evidence', () => {
  it('answers CORS preflight', async () => {
    const res = await OPTIONS(new Request('https://test.imajin.ai/x') as never);
    expect(res.status).toBe(204);
  });

  it('returns 201 with the stored attestation ids when rows were inserted', async () => {
    mockIngest.mockResolvedValueOnce({
      ok: true,
      turnEventId: 'turn_evt_0001',
      inserted: [
        { id: 'att_1', seq: 0 },
        { id: 'att_2', seq: 1 },
      ],
      duplicateSeqs: [],
    });

    const res = await POST(post(valid()) as never);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      turnEventId: 'turn_evt_0001',
      attestations: [
        { id: 'att_1', seq: 0 },
        { id: 'att_2', seq: 1 },
      ],
      duplicateSeqs: [],
    });
    // The parsed batch and the production deps are what reach the core.
    const [batch, deps] = mockIngest.mock.calls[0];
    expect(batch.items).toHaveLength(2);
    expect(deps).toEqual({ marker: 'deps' });
  });

  it('returns 200 when every row was an idempotent replay', async () => {
    mockIngest.mockResolvedValueOnce({ ok: true, turnEventId: 'turn_evt_0001', inserted: [], duplicateSeqs: [0, 1] });
    const res = await POST(post(valid()) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).duplicateSeqs).toEqual([0, 1]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['an empty batch', { evidence: [] }],
    ['a payload with an unknown (potentially secret-bearing) key', {
      evidence: [{ ...valid().evidence[0], payload: { ...valid().evidence[0].payload, authorization: 'Bearer sk-1' } }],
    }],
  ])('rejects %s with 400 before ingest', async (_label, body) => {
    const res = await POST(post(body) as never);
    expect(res.status).toBe(400);
    expect(mockIngest).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain('sk-1');
  });

  it.each([
    [400, 'evidence_signature_invalid'],
    [403, 'evidence_publisher_unauthorized'],
    [422, 'evidence_usage_ref_unresolved'],
  ])('maps a rejected batch (%i %s) through with its code', async (status, code) => {
    mockIngest.mockResolvedValueOnce({ ok: false, status, error: 'nope', code });
    const res = await POST(post(valid()) as never);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'nope', code });
  });

  it('omits code when the rejection has none', async () => {
    mockIngest.mockResolvedValueOnce({ ok: false, status: 400, error: 'bad' });
    const res = await POST(post(valid()) as never);
    expect(await res.json()).toEqual({ error: 'bad' });
  });

  it('returns a generic 500 (no internals) when storage fails', async () => {
    mockIngest.mockRejectedValueOnce(new Error('connection refused at 10.0.0.5'));
    const res = await POST(post(valid()) as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Failed to store turn evidence' });
  });

  it('rate-limits per client IP with Retry-After, before parsing or touching storage', async () => {
    mockIngest.mockResolvedValue({ ok: true, turnEventId: 't', inserted: [], duplicateSeqs: [] });
    const ip = '198.51.100.77';

    for (let i = 0; i < INGEST_RATE_LIMIT; i++) {
      expect((await POST(post(valid(), ip) as never)).status).toBe(200);
    }
    mockIngest.mockClear();
    const limited = await POST(post('{not even json', ip) as never);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(mockIngest).not.toHaveBeenCalled();

    // A different client is unaffected.
    expect((await POST(post(valid(), '198.51.100.78') as never)).status).toBe(200);
  });
});
