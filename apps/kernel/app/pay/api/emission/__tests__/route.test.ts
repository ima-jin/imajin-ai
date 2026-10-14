import { afterEach, describe, expect, it, vi } from 'vitest';

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock('@/src/lib/pay/emission-core', () => ({ emitMjnx: emitMock }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

import { POST } from '../route';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('closed HTTP emission endpoint (#2735)', () => {
  it.each([
    {},
    { Authorization: 'Bearer old-shared-key' },
    { Authorization: 'Bearer app-service-jwt', 'x-app-did': 'did:imajin:app' },
    { Cookie: 'session=user-session' },
  ])('refuses credential %j without invoking the ledger', async (headers) => {
    vi.stubEnv('PAY_SERVICE_API_KEY', 'old-shared-key');
    const request = new Request('https://kernel.test/pay/api/emission', {
      method: 'POST',
      headers,
      body: JSON.stringify({ to_did: 'did:imajin:x', amount: 10, unit: 'MJNx', reason: 'test' }),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Emission is kernel-internal only' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.test');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('refuses even a malformed body without parsing it', async () => {
    const response = await POST(new Request('https://kernel.test/pay/api/emission', {
      method: 'POST', body: 'not-json',
    }) as never);
    expect(response.status).toBe(403);
  });
});
