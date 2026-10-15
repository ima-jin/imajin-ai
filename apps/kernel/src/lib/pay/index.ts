/**
 * Kernel pay provider - Unified Payment Infrastructure
 * 
 * One interface. Two worlds. No lock-in.
 * 
 * @example
 * import { PaymentService } from '@/src/lib/pay';
 * 
 * // The legacy service supports independently configured Solana payments.
 * // Card payments use the transacting DID's sealed connector through the
 * // seller/node adapters; the old platform Stripe provider fails closed.
 * const pay = new PaymentService({
 *   providers: {
 *     solana: { rpcUrl: process.env.SOLANA_RPC_URL },
 *   },
 * });
 * 
 * // Crypto payment (routes to Solana)
 * await pay.charge({ amount: 100000000, currency: 'SOL', to: { solanaAddress: 'xxx' } });
 */

// Constants
export const DEFAULT_PLATFORM_FEE_BPS = 100; // 1%

// Main service
export { PaymentService } from './service';

// Types
export * from './types';

// Providers (for direct access when needed)
export { StripeProvider, SolanaProvider } from './providers/index';
export type { PaymentProvider, HealthCheckResult, ProviderCapabilities } from './providers/types';
