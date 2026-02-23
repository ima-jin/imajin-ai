/**
 * Payment Provider Interface
 * 
 * Contract that all payment providers must implement.
 */

import type {
  ChargeRequest,
  ChargeResult,
  CheckoutRequest,
  CheckoutResult,
  EscrowRequest,
  EscrowResult,
  RefundRequest,
  RefundResult,
  SubscriptionRequest,
  SubscriptionResult,
} from '../types.js';

/** Health check result */
export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
}

/** Provider capabilities */
export interface ProviderCapabilities {
  /** Can process direct charges */
  charge: boolean;
  /** Can create hosted checkout sessions */
  checkout: boolean;
  /** Can hold funds in escrow */
  escrow: boolean;
  /** Can manage subscriptions */
  subscriptions: boolean;
  /** Can process refunds */
  refunds: boolean;
}

/**
 * Payment Provider Interface
 * 
 * All providers implement this contract for unified payment handling.
 */
export interface PaymentProvider {
  /** Provider name */
  readonly name: 'stripe' | 'solana';
  
  /** What this provider can do */
  readonly capabilities: ProviderCapabilities;
  
  /** Check provider health/connectivity */
  healthCheck(): Promise<HealthCheckResult>;
  
  /** Process a charge */
  charge(request: ChargeRequest): Promise<ChargeResult>;
  
  /** Create hosted checkout session (optional) */
  checkout?(request: CheckoutRequest): Promise<CheckoutResult>;
  
  /** Create escrow (optional) */
  escrow?(request: EscrowRequest): Promise<EscrowResult>;
  
  /** Release funds from escrow (optional) */
  releaseEscrow?(escrowId: string): Promise<EscrowResult>;
  
  /** Refund escrow to depositor (optional) */
  refundEscrow?(escrowId: string): Promise<EscrowResult>;
  
  /** Process refund (optional) */
  refund?(request: RefundRequest): Promise<RefundResult>;
  
  /** Create subscription (optional) */
  createSubscription?(request: SubscriptionRequest): Promise<SubscriptionResult>;
  
  /** Cancel subscription (optional) */
  cancelSubscription?(subscriptionId: string): Promise<SubscriptionResult>;
  
  /** Get subscription details (optional) */
  getSubscription?(subscriptionId: string): Promise<SubscriptionResult>;
}
