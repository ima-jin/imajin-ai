import { describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/moonshot/connector', () => ({ MOONSHOT_BASE_URL: 'https://api.moonshot.ai/v1' }));
import { createMoonshotBalanceReader } from '../moonshot';

const key = 'mock-billing-key';
const envelope = {
  code: 0, status: true,
  data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
};

describe('Moonshot balance reader', () => {
  it('reads the documented USD snapshot, not a billed line or balance-derived spend', async () => {
    const http = vi.fn().mockResolvedValue(Response.json(envelope));
    const reader = createMoonshotBalanceReader({ apiKey: key, fetchImpl: http });
    expect(await reader.fetch()).toEqual({ currency: 'USD', available: 49.58894, voucher: 46.58893, cash: 3.00001 });
    expect(reader.billedMode).toBe('manual-only');
    expect(http).toHaveBeenCalledWith('https://api.moonshot.ai/v1/users/me/balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal: expect.any(AbortSignal),
    });
  });

  it('permits documented cash deficits without manufacturing a charge', async () => {
    const http = vi.fn().mockResolvedValue(Response.json({ ...envelope, data: { ...envelope.data, cash_balance: -2 } }));
    expect((await createMoonshotBalanceReader({ apiKey: key, fetchImpl: http }).fetch()).cash).toBe(-2);
  });

  it.each([
    null, {}, { ...envelope, status: false }, { ...envelope, code: 123 },
    { ...envelope, data: {} }, { ...envelope, data: { ...envelope.data, voucher_balance: -1 } },
    { ...envelope, data: { ...envelope.data, cash_balance: '3' } },
  ])('rejects incomplete or in-band failure responses', async (body) => {
    const http = vi.fn().mockResolvedValue(Response.json(body));
    await expect(createMoonshotBalanceReader({ apiKey: key, fetchImpl: http }).fetch())
      .rejects.toThrow('Invalid Moonshot balance response');
  });

  it.each([401, 403, 500])('sanitizes HTTP %s without reading provider error bodies', async (status) => {
    const http = vi.fn().mockResolvedValue(new Response(key, { status }));
    const error = await createMoonshotBalanceReader({ apiKey: key, fetchImpl: http }).fetch().catch((err: Error) => err);
    expect(error).toMatchObject({ status, message: 'Moonshot balance unavailable' });
    expect(String(error)).not.toContain(key);
  });

  it('sanitizes transport and JSON-parser exceptions', async () => {
    const http = vi.fn().mockRejectedValue(new Error(key));
    await expect(createMoonshotBalanceReader({ apiKey: key, fetchImpl: http }).fetch())
      .rejects.toThrow('Moonshot balance unavailable');
    http.mockResolvedValue(new Response(key));
    await expect(createMoonshotBalanceReader({ apiKey: key, fetchImpl: http }).fetch())
      .rejects.toThrow('Moonshot balance unavailable');
  });

  it('aborts a stalled balance request and reports only a safe error', async () => {
    const http: typeof fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(key)), { once: true });
    }));
    await expect(createMoonshotBalanceReader({ apiKey: key, fetchImpl: http, timeoutMs: 5 }).fetch())
      .rejects.toThrow('Moonshot balance unavailable');
  });
});
