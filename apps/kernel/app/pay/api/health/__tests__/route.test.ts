import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ready: vi.fn(), service: vi.fn(), health: vi.fn() }));
vi.mock('@/src/lib/pay/providers/node-card-rail', () => ({ isNodeCardRailConfigured: h.ready }));
vi.mock('@/src/lib/pay/pay', () => ({ getPaymentService: h.service }));
import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SOLANA_RPC_URL', undefined);
  h.ready.mockResolvedValue(false);
  h.service.mockReturnValue({ healthCheck: h.health });
  h.health.mockResolvedValue({ solana: { healthy: true } });
});
afterEach(() => vi.unstubAllEnvs());

describe('payment health', () => {
  it('reports cards unavailable even when an obsolete env key is set', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake_ignored');
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      providers: { stripe: { healthy: false, message: 'Card rail not configured for this node' } },
    });
    expect(h.service).not.toHaveBeenCalled();
  });

  it('reports a ready node connector without constructing the legacy payment service', async () => {
    h.ready.mockResolvedValue(true);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'healthy', providers: { stripe: { healthy: true } } });
    expect(h.service).not.toHaveBeenCalled();
  });

  it('keeps Solana health separate from sealed card readiness', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.test.invalid');
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      providers: { stripe: { healthy: false }, solana: { healthy: true } },
    });
    expect(h.health).toHaveBeenCalledOnce();
  });

  it('reports independent provider degradation', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.test.invalid');
    h.ready.mockResolvedValue(true);
    h.health.mockResolvedValue({ solana: { healthy: false } });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'degraded' });
  });

  it('does not expose provider diagnostics if the probe fails', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.test.invalid');
    h.health.mockRejectedValue(new Error('test-only-private-diagnostic'));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'unhealthy', error: 'Health check failed' });
  });
});
