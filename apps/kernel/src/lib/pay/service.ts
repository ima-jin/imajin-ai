/**
 * PaymentService - Unified Payment API
 * 
 * Routes payments to appropriate provider based on currency.
 * Abstracts Stripe (fiat) and Solana (crypto) behind one interface.
 */

import type {
  PaymentServiceConfig,
  Currency,
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
  isFiatCurrency,
  isCryptoCurrency,
} from './types';
import type { PaymentProvider, HealthCheckResult } from './providers/types';
import { StripeProvider } from './providers/stripe';
import { SolanaProvider } from './providers/solana';

export class PaymentService {
  private providers: Map<string, PaymentProvider> = new Map();
  private config: PaymentServiceConfig;
  
  constructor(config: PaymentServiceConfig) {
    this.config = config;
    
    // Initialize configured providers
    if (config.providers.stripe) {
      this.providers.set('stripe', new StripeProvider(config.providers.stripe));
    }
    
    if (config.providers.solana) {
      this.providers.set('solana', new SolanaProvider(config.providers.solana));
    }
    
    if (this.providers.size === 0) {
      throw new Error('At least one payment provider must be configured');
    }
  }
  
  // ===========================================================================
  // Provider Selection
  // ===========================================================================
  
  /** Get provider for a given currency */
  private getProviderForCurrency(currency: Currency): PaymentProvider {
    const isCrypto = ['SOL', 'USDC', 'MJN'].includes(currency);
    const providerName = isCrypto
      ? (this.config.defaultCryptoProvider || 'solana')
      : (this.config.defaultFiatProvider || 'stripe');
    
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(
        `Provider '${providerName}' not configured. ` +
        `Required for ${currency} payments.`
      );
    }
    
    return provider;
  }
  
  /** Get a specific provider by name */
  private getProvider(name: 'stripe' | 'solana'): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider '${name}' not configured`);
    }
    return provider;
  }
  
  // ===========================================================================
  // Health Check
  // ===========================================================================
  
  /** Check health of all configured providers */
  async healthCheck(): Promise<Record<string, HealthCheckResult>> {
    const results: Record<string, HealthCheckResult> = {};
    
    for (const [name, provider] of this.providers) {
      results[name] = await provider.healthCheck();
    }
    
    return results;
  }
  
  /** Check if a specific provider is healthy */
  async isHealthy(provider?: 'stripe' | 'solana'): Promise<boolean> {
    if (provider) {
      const p = this.providers.get(provider);
      if (!p) return false;
      const result = await p.healthCheck();
      return result.healthy;
    }
    
    // Check all providers
    const results = await this.healthCheck();
    return Object.values(results).every(r => r.healthy);
  }
  
  // ===========================================================================
  // Charge
  // ===========================================================================
  
  /**
   * Process a payment charge
   * 
   * Routes to appropriate provider based on currency:
   * - USD/CAD/EUR/GBP → Stripe
   * - SOL/USDC/MJN → Solana
   * 
   * @example
   * // Fiat payment (Stripe)
   * await pay.charge({
   *   amount: 1500, // $15.00 in cents
   *   currency: 'USD',
   *   to: { stripeCustomerId: 'cus_xxx' },
   * });
   * 
   * @example
   * // Crypto payment (Solana)
   * await pay.charge({
   *   amount: 100000000, // 0.1 SOL in lamports
   *   currency: 'SOL',
   *   to: { solanaAddress: 'xxx...' },
   * });
   */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const provider = this.getProviderForCurrency(request.currency);
    return provider.charge(request);
  }
  
  // ===========================================================================
  // Checkout
  // ===========================================================================
  
  /**
   * Create a hosted checkout session
   * 
   * Only available for fiat currencies via Stripe.
   * Returns a URL to redirect the customer to.
   * 
   * @example
   * const { url } = await pay.checkout({
   *   items: [{ name: 'Widget', amount: 1999, quantity: 1 }],
   *   currency: 'USD',
   *   successUrl: 'https://example.com/success',
   *   cancelUrl: 'https://example.com/cancel',
   * });
   * // Redirect customer to `url`
   */
  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    const provider = this.getProvider('stripe');
    
    if (!provider.checkout) {
      throw new Error('Checkout not available');
    }
    
    return provider.checkout(request);
  }
  
  // ===========================================================================
  // Escrow
  // ===========================================================================
  
  /**
   * Create an escrow (hold funds until released)
   * 
   * For Stripe: Uses PaymentIntent with manual capture
   * For Solana: Uses escrow program (not yet implemented)
   */
  async escrow(request: EscrowRequest): Promise<EscrowResult> {
    const provider = this.getProviderForCurrency(request.currency);
    
    if (!provider.escrow) {
      throw new Error(`Escrow not supported by ${provider.name} provider`);
    }
    
    return provider.escrow(request);
  }
  
  /**
   * Release funds from escrow to recipient
   */
  async releaseEscrow(escrowId: string, provider: 'stripe' | 'solana'): Promise<EscrowResult> {
    const p = this.getProvider(provider);
    
    if (!p.releaseEscrow) {
      throw new Error(`Escrow release not supported by ${provider} provider`);
    }
    
    return p.releaseEscrow(escrowId);
  }
  
  /**
   * Refund escrow back to depositor
   */
  async refundEscrow(escrowId: string, provider: 'stripe' | 'solana'): Promise<EscrowResult> {
    const p = this.getProvider(provider);
    
    if (!p.refundEscrow) {
      throw new Error(`Escrow refund not supported by ${provider} provider`);
    }
    
    return p.refundEscrow(escrowId);
  }
  
  // ===========================================================================
  // Refunds
  // ===========================================================================
  
  /**
   * Refund a payment
   * 
   * Only available for Stripe (blockchain is immutable).
   */
  async refund(request: RefundRequest): Promise<RefundResult> {
    const provider = this.getProvider('stripe');
    
    if (!provider.refund) {
      throw new Error('Refunds not available');
    }
    
    return provider.refund(request);
  }
  
  // ===========================================================================
  // Subscriptions
  // ===========================================================================
  
  /**
   * Create a subscription
   * 
   * Only available via Stripe.
   */
  async createSubscription(request: SubscriptionRequest): Promise<SubscriptionResult> {
    const provider = this.getProvider('stripe');
    
    if (!provider.createSubscription) {
      throw new Error('Subscriptions not available');
    }
    
    return provider.createSubscription(request);
  }
  
  /**
   * Cancel a subscription
   */
  async cancelSubscription(subscriptionId: string): Promise<SubscriptionResult> {
    const provider = this.getProvider('stripe');
    
    if (!provider.cancelSubscription) {
      throw new Error('Subscriptions not available');
    }
    
    return provider.cancelSubscription(subscriptionId);
  }
  
  /**
   * Get subscription details
   */
  async getSubscription(subscriptionId: string): Promise<SubscriptionResult> {
    const provider = this.getProvider('stripe');
    
    if (!provider.getSubscription) {
      throw new Error('Subscriptions not available');
    }
    
    return provider.getSubscription(subscriptionId);
  }
  
  // ===========================================================================
  // Utilities
  // ===========================================================================
  
  /** Get list of configured providers */
  getConfiguredProviders(): string[] {
    return Array.from(this.providers.keys());
  }
  
  /** Check if a currency is supported */
  supportsCurrency(currency: Currency): boolean {
    try {
      this.getProviderForCurrency(currency);
      return true;
    } catch {
      return false;
    }
  }
  
  /** Get capabilities for a provider */
  getCapabilities(provider: 'stripe' | 'solana') {
    return this.getProvider(provider).capabilities;
  }
}
