/**
 * @imajin/pay - Unified Payment Infrastructure
 * 
 * One interface. Two worlds. No lock-in.
 * 
 * @example
 * import { PaymentService } from '@imajin/pay';
 * 
 * const pay = new PaymentService({
 *   providers: {
 *     stripe: { secretKey: process.env.STRIPE_SECRET_KEY },
 *     solana: { rpcUrl: process.env.SOLANA_RPC_URL },
 *   },
 * });
 * 
 * // Fiat payment (routes to Stripe)
 * await pay.charge({ amount: 1500, currency: 'USD', to: { stripeCustomerId: 'cus_xxx' } });
 * 
 * // Crypto payment (routes to Solana)
 * await pay.charge({ amount: 100000000, currency: 'SOL', to: { solanaAddress: 'xxx' } });
 */

// Main service
export { PaymentService } from './service';

// Types
export * from './types';

// Providers (for direct access when needed)
export { StripeProvider, SolanaProvider } from './providers/index';
export type { PaymentProvider, HealthCheckResult, ProviderCapabilities } from './providers/types';
