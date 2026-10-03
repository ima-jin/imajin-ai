/**
 * Tests for `GET /auth/api/verify/turn/:hash` (#1978) — public, no auth.
 * The verify core (`verifyTurnByHash`) is mocked here and covered with real
 * signatures — valid / tampered / unknown — in
 * `src/lib/turn-evidence/__tests__/verify.test.ts`. Rate limiting runs for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VERIFY_RATE_LIMIT } from '@/src/lib/turn-evidence/config';

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'access-control-allow-origin': '*' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/turn-evidence/verify', () => ({ verifyTurnByHash: mockVerify }));
vi.mock('@/src/lib/turn-evidence/verify-deps', () => ({ productionVerifyDeps: { marker: 'deps' } }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET, OPTIONS } from '../route';

const HASH = `sha256:${'ab'.repeat(32)}`;

let ipCounter = 0;
function get(rawHash: string, ip = `192.0.2.${++ipCounter}`) {
  // Deliberately no cookie, no Authorization header: the endpoint is public.
  const request = new Request(`https://test.imajin.ai/auth/api/verify/turn/${rawHash}`, {
    headers: { 'x-forwarded-for': ip },
  });
  return GET(request as never, { params: Promise.resolve({ hash: rawHash }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /auth/api/verify/turn/:hash', () => {
  it('answers CORS preflight', async () => {
    expect((await OPTIONS(new Request('https://test.imajin.ai/x') as never)).status).toBe(204);
  });

  it('serves a found chain to an unauthenticated client, uncached', async () => {
    const matches = [{ turnEventId: 'turn_evt_0001', valid: true, evidence: [] }];
    mockVerify.mockResolvedValueOnce({ found: true, hash: HASH, matches });

    const res = await get(HASH);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ hash: HASH, matches });
    expect(mockVerify).toHaveBeenCalledWith(HASH, { marker: 'deps' });
  });

  it('normalizes bare-hex and URL-encoded hashes before verifying', async () => {
    mockVerify.mockResolvedValue({ found: true, hash: HASH, matches: [] });

    await get('AB'.repeat(32));
    await get(encodeURIComponent(HASH));

    expect(mockVerify.mock.calls.map((call) => call[0])).toEqual([HASH, HASH]);
  });

  it('returns 404 for a hash nothing is committed under', async () => {
    mockVerify.mockResolvedValueOnce({ found: false });
    const res = await get(HASH);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No evidence is committed under this hash' });
  });

  it.each(['not-a-hash', 'sha256:abc', `sha256:${'z'.repeat(64)}`, '%E0%A4%A'])(
    'returns 400 for malformed hash %s, without touching storage',
    async (bad) => {
      const res = await get(bad);
      expect(res.status).toBe(400);
      expect(mockVerify).not.toHaveBeenCalled();
    },
  );

  it('returns a generic 500 when verification fails unexpectedly', async () => {
    mockVerify.mockRejectedValueOnce(new Error('relation "auth.attestations" does not exist'));
    const res = await get(HASH);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to verify turn' });
  });

  it('is rate-limited per client IP: 429 with Retry-After once the budget is spent', async () => {
    mockVerify.mockResolvedValue({ found: false });
    const ip = '198.51.100.9';

    for (let i = 0; i < VERIFY_RATE_LIMIT; i++) {
      expect((await get(HASH, ip)).status).toBe(404);
    }
    mockVerify.mockClear();
    const limited = await get(HASH, ip);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(mockVerify).not.toHaveBeenCalled();

    // Another client still gets through.
    expect((await get(HASH, '198.51.100.10')).status).toBe(404);
  });
});
