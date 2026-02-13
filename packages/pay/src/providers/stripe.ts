/**
 * Stripe Payment Provider
 * 
 * Implements PaymentProvider for Stripe (fiat payments).
 * 
 * Capabilities:
 * - Direct charges via Payment Intents
 * - Hosted checkout sessions
 * - Escrow via manual capture
 * - Subscriptions
 * - Refunds
 */

import Stripe from 'stripe';
import type { PaymentProvider, HealthCheckResult, ProviderCapabilities } from './types.js';
import type {
  StripeProviderConfig,
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
  PaymentStatus,
  Recipient,
  isStripeRecipient,
  isDIDRecipient,
} from '../types.js';

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  
  readonly capabilities: ProviderCapabilities = {
    charge: true,
    checkout: true,
    escrow: true,
    subscriptions: true,
    refunds: true,
  };
  
  private stripe: Stripe;
  private config: StripeProviderConfig;
  
  constructor(config: StripeProviderConfig) {
    this.config = config;
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: (config.apiVersion || '2025-09-30.clover') as any,
      timeout: config.timeout || 60000,
      maxNetworkRetries: config.maxNetworkRetries || 3,
    });
  }
  
  // ===========================================================================
  // Health Check
  // ===========================================================================
  
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      await this.stripe.accounts.retrieve();
      return {
        healthy: true,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        latencyMs: Date.now() - start,
      };
    }
  }
  
  // ===========================================================================
  // Charge
  // ===========================================================================
  
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const recipientInfo = await this.resolveRecipient(request.to);
    
    const params: Stripe.PaymentIntentCreateParams = {
      amount: request.amount,
      currency: request.currency.toLowerCase(),
      description: request.description,
      metadata: {
        ...request.metadata,
        from_did: request.from || '',
      },
      automatic_payment_methods: { enabled: true },
    };
    
    if (recipientInfo.customerId) {
      params.customer = recipientInfo.customerId;
    }
    
    const paymentIntent = await this.stripe.paymentIntents.create(params, {
      idempotencyKey: request.idempotencyKey,
    });
    
    return {
      id: paymentIntent.id,
      provider: 'stripe',
      status: this.mapPaymentStatus(paymentIntent.status),
      amount: paymentIntent.amount,
      currency: request.currency,
      clientSecret: paymentIntent.client_secret || undefined,
      createdAt: new Date(paymentIntent.created * 1000),
      metadata: paymentIntent.metadata as Record<string, string>,
    };
  }
  
  // ===========================================================================
  // Checkout
  // ===========================================================================
  
  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'link'],
      line_items: request.items.map(item => ({
        price_data: {
          currency: request.currency.toLowerCase(),
          product_data: {
            name: item.name,
            description: item.description,
            images: item.image ? [item.image] : undefined,
          },
          unit_amount: item.amount,
        },
        quantity: item.quantity,
      })),
      customer_email: request.customerEmail,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      metadata: request.metadata,
      expires_at: Math.floor(Date.now() / 1000) + 3600 * 24, // 24 hours
    });
    
    return {
      id: session.id,
      url: session.url!,
      expiresAt: new Date(session.expires_at * 1000),
    };
  }
  
  // ===========================================================================
  // Escrow (via manual capture)
  // ===========================================================================
  
  async escrow(request: EscrowRequest): Promise<EscrowResult> {
    // Create PaymentIntent with manual capture = funds held until captured
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: request.amount,
      currency: request.currency.toLowerCase(),
      capture_method: 'manual',
      metadata: {
        escrow: 'true',
        from_did: request.from,
        to_did: request.to,
        arbiter_did: request.arbiter || '',
        ...request.metadata,
      },
    });
    
    return {
      id: paymentIntent.id,
      provider: 'stripe',
      status: 'held',
      amount: request.amount,
      currency: request.currency,
      from: request.from,
      to: request.to,
      createdAt: new Date(paymentIntent.created * 1000),
    };
  }
  
  async releaseEscrow(escrowId: string): Promise<EscrowResult> {
    const paymentIntent = await this.stripe.paymentIntents.capture(escrowId);
    
    return {
      id: paymentIntent.id,
      provider: 'stripe',
      status: 'released',
      amount: paymentIntent.amount,
      currency: paymentIntent.currency.toUpperCase() as any,
      from: paymentIntent.metadata.from_did || '',
      to: paymentIntent.metadata.to_did || '',
      createdAt: new Date(paymentIntent.created * 1000),
    };
  }
  
  async refundEscrow(escrowId: string): Promise<EscrowResult> {
    const paymentIntent = await this.stripe.paymentIntents.cancel(escrowId);
    
    return {
      id: paymentIntent.id,
      provider: 'stripe',
      status: 'refunded',
      amount: paymentIntent.amount,
      currency: paymentIntent.currency.toUpperCase() as any,
      from: paymentIntent.metadata.from_did || '',
      to: paymentIntent.metadata.to_did || '',
      createdAt: new Date(paymentIntent.created * 1000),
    };
  }
  
  // ===========================================================================
  // Refunds
  // ===========================================================================
  
  async refund(request: RefundRequest): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create({
      payment_intent: request.paymentId,
      amount: request.amount,
      reason: request.reason as Stripe.RefundCreateParams.Reason,
    });
    
    return {
      id: refund.id,
      paymentId: request.paymentId,
      amount: refund.amount,
      status: refund.status === 'succeeded' ? 'succeeded' : 'pending',
    };
  }
  
  // ===========================================================================
  // Subscriptions
  // ===========================================================================
  
  async createSubscription(request: SubscriptionRequest): Promise<SubscriptionResult> {
    const subscription = await this.stripe.subscriptions.create({
      customer: request.customerId,
      items: [{ price: request.priceId }],
      trial_period_days: request.trialDays,
      metadata: request.metadata,
    });
    
    return this.mapSubscription(subscription);
  }
  
  async cancelSubscription(subscriptionId: string): Promise<SubscriptionResult> {
    const subscription = await this.stripe.subscriptions.cancel(subscriptionId);
    return this.mapSubscription(subscription);
  }
  
  async getSubscription(subscriptionId: string): Promise<SubscriptionResult> {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    return this.mapSubscription(subscription);
  }
  
  // ===========================================================================
  // Helpers
  // ===========================================================================
  
  private async resolveRecipient(recipient: Recipient): Promise<{ customerId?: string; accountId?: string }> {
    // TODO: Integrate with @imajin/auth to resolve DIDs
    if ('did' in recipient) {
      // For now, throw - will implement DID resolution later
      throw new Error('DID resolution not yet implemented. Use stripeCustomerId directly.');
    }
    
    if ('stripeCustomerId' in recipient) {
      return { customerId: recipient.stripeCustomerId };
    }
    
    if ('stripeAccountId' in recipient) {
      return { accountId: recipient.stripeAccountId };
    }
    
    return {};
  }
  
  private mapPaymentStatus(status: Stripe.PaymentIntent.Status): PaymentStatus {
    switch (status) {
      case 'succeeded':
        return 'succeeded';
      case 'processing':
        return 'pending';
      case 'requires_action':
      case 'requires_confirmation':
      case 'requires_payment_method':
        return 'requires_action';
      case 'canceled':
        return 'canceled';
      default:
        return 'failed';
    }
  }
  
  private mapSubscription(sub: Stripe.Subscription): SubscriptionResult {
    return {
      id: sub.id,
      status: sub.status as any,
      currentPeriodStart: new Date((sub as any).current_period_start * 1000),
      currentPeriodEnd: new Date((sub as any).current_period_end * 1000),
    };
  }
}
