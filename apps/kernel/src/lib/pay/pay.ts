/**
 * Payment Service Instance
 * 
 * Configured from environment variables.
 */

import { PaymentService } from '@/src/lib/pay';
import type { PaymentServiceConfig } from '@/src/lib/pay';
import { isStripeConfigured } from '@/src/lib/pay/providers/stripe-client';

let paymentService: PaymentService | null = null;

export function getPaymentService(): PaymentService {
  if (paymentService) {
    return paymentService;
  }
  
  const config: PaymentServiceConfig = {
    providers: {},
  };
  
  // Configure Stripe if a key is present. #2174: `isStripeConfigured()` is
  // the only place `STRIPE_SECRET_KEY` is read — `StripeProviderConfig` no
  // longer carries the raw key, since `StripeProvider` sources its client
  // from the shared adapter singleton instead.
  if (isStripeConfigured()) {
    config.providers.stripe = {
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    };
  }
  
  // Configure Solana if RPC URL is present
  if (process.env.SOLANA_RPC_URL) {
    config.providers.solana = {
      rpcUrl: process.env.SOLANA_RPC_URL,
    };
  }
  
  if (!config.providers.stripe && !config.providers.solana) {
    throw new Error(
      'No payment providers configured. Set STRIPE_SECRET_KEY and/or SOLANA_RPC_URL.'
    );
  }
  
  paymentService = new PaymentService(config);
  return paymentService;
}

/** Helper to get Stripe publishable key for frontend */
export function getStripePublishableKey(): string | undefined {
  return process.env.STRIPE_PUBLISHABLE_KEY;
}
