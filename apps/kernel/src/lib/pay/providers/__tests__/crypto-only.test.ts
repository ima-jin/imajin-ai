import { afterEach, expect, it, vi } from 'vitest';
const constructor = vi.hoisted(() => vi.fn());
vi.mock('../solana', () => ({ SolanaProvider: class { constructor(config: unknown) { constructor(config); } } }));
vi.mock('../stripe-client', () => { throw new Error('Crypto must not load platform adapter'); });
import { getCryptoOnlyProvider } from '../crypto-only';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('constructs only Solana with configured RPC', () => {
  vi.stubEnv('SOLANA_RPC_URL', 'http://localhost:8899');
  getCryptoOnlyProvider();
  expect(constructor).toHaveBeenCalledWith({ rpcUrl: 'http://localhost:8899' });
});
it('fails clearly without Solana RPC rather than using Stripe', () => {
  vi.stubEnv('SOLANA_RPC_URL', '');
  expect(() => getCryptoOnlyProvider()).toThrow('Solana provider not configured');
  expect(constructor).not.toHaveBeenCalled();
});
