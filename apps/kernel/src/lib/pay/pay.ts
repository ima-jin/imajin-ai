/**
 * Payment Service Instance
 * 
 * Legacy service for the independently configured Solana provider.
 * Card operations must use the transacting DID's sealed connector instead.
 */

import { PaymentService } from '@/src/lib/pay';
import type { PaymentServiceConfig } from '@/src/lib/pay';

let paymentService: PaymentService | null = null;

export function getPaymentService(): PaymentService {
  if (paymentService) {
    return paymentService;
  }
  
  const config: PaymentServiceConfig = {
    providers: {},
  };
  
  // Configure Solana if RPC URL is present
  if (process.env.SOLANA_RPC_URL) {
    config.providers.solana = {
      rpcUrl: process.env.SOLANA_RPC_URL,
    };
  }
  
  if (!config.providers.solana) {
    throw new Error(
      'No legacy payment provider configured. Cards require a DID-bound sealed connector; Solana requires SOLANA_RPC_URL.'
    );
  }
  
  paymentService = new PaymentService(config);
  return paymentService;
}

/** @deprecated Resolve the transacting DID's sealed publishable key instead. */
export function getStripePublishableKey(): string | undefined {
  return undefined;
}
