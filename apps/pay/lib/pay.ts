/**
 * Payment Service Instance
 * 
 * Configured from environment variables.
 */

import { PaymentService } from '@/lib';
import type { PaymentServiceConfig } from '@/lib';

let paymentService: PaymentService | null = null;

export function getPaymentService(): PaymentService {
  if (paymentService) {
    return paymentService;
  }
  
  const config: PaymentServiceConfig = {
    providers: {},
  };
  
  // Configure Stripe if key is present
  if (process.env.STRIPE_SECRET_KEY) {
    config.providers.stripe = {
      secretKey: process.env.STRIPE_SECRET_KEY,
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
