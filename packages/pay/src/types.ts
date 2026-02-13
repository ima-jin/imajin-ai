/**
 * @imajin/pay - Type definitions
 * 
 * Unified payment types that work across providers (Stripe, Solana).
 */

// ============================================================================
// Currency Types
// ============================================================================

/** Fiat currencies supported via Stripe */
export type FiatCurrency = 'USD' | 'CAD' | 'EUR' | 'GBP';

/** Crypto currencies supported via Solana */
export type CryptoCurrency = 'SOL' | 'USDC' | 'MJN';

/** All supported currencies */
export type Currency = FiatCurrency | CryptoCurrency;

/** Check if currency is fiat */
export function isFiatCurrency(currency: Currency): currency is FiatCurrency {
  return ['USD', 'CAD', 'EUR', 'GBP'].includes(currency);
}

/** Check if currency is crypto */
export function isCryptoCurrency(currency: Currency): currency is CryptoCurrency {
  return ['SOL', 'USDC', 'MJN'].includes(currency);
}

// ============================================================================
// Recipient Types
// ============================================================================

/** DID-based recipient (resolved via identity layer) */
export interface DIDRecipient {
  did: string;
}

/** Direct Stripe recipient */
export interface StripeRecipient {
  stripeAccountId?: string;
  stripeCustomerId?: string;
}

/** Direct Solana recipient */
export interface SolanaRecipient {
  solanaAddress: string;
}

/** Payment recipient - DID or provider-specific */
export type Recipient = DIDRecipient | StripeRecipient | SolanaRecipient;

/** Check recipient type */
export function isDIDRecipient(r: Recipient): r is DIDRecipient {
  return 'did' in r;
}

export function isStripeRecipient(r: Recipient): r is StripeRecipient {
  return 'stripeAccountId' in r || 'stripeCustomerId' in r;
}

export function isSolanaRecipient(r: Recipient): r is SolanaRecipient {
  return 'solanaAddress' in r;
}

// ============================================================================
// Payment Status
// ============================================================================

export type PaymentStatus = 
  | 'pending'           // Processing
  | 'requires_action'   // Needs user action (3DS, wallet signature)
  | 'succeeded'         // Complete
  | 'failed'            // Error
  | 'canceled';         // User canceled

export type EscrowStatus =
  | 'held'              // Funds locked
  | 'released'          // Funds sent to recipient
  | 'refunded'          // Funds returned to sender
  | 'disputed';         // Under review

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trialing'
  | 'paused';

export type RefundStatus =
  | 'pending'
  | 'succeeded'
  | 'failed';

// ============================================================================
// Charge Types
// ============================================================================

/** Request to charge a payment */
export interface ChargeRequest {
  /** Amount in smallest unit (cents for fiat, lamports for SOL) */
  amount: number;
  /** Currency to charge */
  currency: Currency;
  /** Who receives the payment */
  to: Recipient;
  /** Who is paying (DID, optional - derived from session/wallet) */
  from?: string;
  /** Payment description */
  description?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, string>;
  /** Idempotency key to prevent double-charges */
  idempotencyKey?: string;
}

/** Result of a charge operation */
export interface ChargeResult {
  /** Provider-specific payment ID */
  id: string;
  /** Which provider processed this */
  provider: 'stripe' | 'solana';
  /** Current status */
  status: PaymentStatus;
  /** Amount charged */
  amount: number;
  /** Currency */
  currency: Currency;
  /** Transaction fee (if known) */
  fee?: number;
  /** Solana transaction signature (if applicable) */
  signature?: string;
  /** Stripe client secret for frontend (if applicable) */
  clientSecret?: string;
  /** When created */
  createdAt: Date;
  /** Metadata */
  metadata?: Record<string, string>;
}

// ============================================================================
// Checkout Types
// ============================================================================

/** Item in a checkout session */
export interface CheckoutItem {
  /** Display name */
  name: string;
  /** Description */
  description?: string;
  /** Unit price in cents */
  amount: number;
  /** Quantity */
  quantity: number;
  /** Image URL */
  image?: string;
}

/** Request for hosted checkout */
export interface CheckoutRequest {
  /** Line items */
  items: CheckoutItem[];
  /** Currency (fiat only for checkout) */
  currency: FiatCurrency;
  /** Customer email (pre-fills form) */
  customerEmail?: string;
  /** Redirect on success */
  successUrl: string;
  /** Redirect on cancel */
  cancelUrl: string;
  /** Arbitrary metadata */
  metadata?: Record<string, string>;
}

/** Result of checkout creation */
export interface CheckoutResult {
  /** Session ID */
  id: string;
  /** Redirect URL for hosted checkout */
  url: string;
  /** When session expires */
  expiresAt: Date;
}

// ============================================================================
// Escrow Types
// ============================================================================

/** Request to create escrow */
export interface EscrowRequest {
  /** Amount to escrow */
  amount: number;
  /** Currency */
  currency: Currency;
  /** DID of depositor */
  from: string;
  /** DID of recipient (released to on completion) */
  to: string;
  /** DID of arbiter for disputes (optional) */
  arbiter?: string;
  /** Release conditions */
  conditions?: {
    /** Auto-release after this timestamp */
    releaseAfter?: Date;
    /** DIDs that must sign to release */
    requireSignatures?: string[];
  };
  /** Arbitrary metadata */
  metadata?: Record<string, string>;
}

/** Result of escrow operation */
export interface EscrowResult {
  /** Escrow ID */
  id: string;
  /** Which provider holds this */
  provider: 'stripe' | 'solana';
  /** Current status */
  status: EscrowStatus;
  /** Amount held */
  amount: number;
  /** Currency */
  currency: Currency;
  /** Who deposited */
  from: string;
  /** Who receives on release */
  to: string;
  /** When created */
  createdAt: Date;
  /** When it expires (if applicable) */
  expiresAt?: Date;
}

// ============================================================================
// Subscription Types
// ============================================================================

/** Request to create subscription */
export interface SubscriptionRequest {
  /** Customer identifier (Stripe customer ID or DID) */
  customerId: string;
  /** Stripe price ID */
  priceId: string;
  /** Trial period in days */
  trialDays?: number;
  /** Arbitrary metadata */
  metadata?: Record<string, string>;
}

/** Result of subscription operation */
export interface SubscriptionResult {
  /** Subscription ID */
  id: string;
  /** Current status */
  status: SubscriptionStatus;
  /** Current billing period start */
  currentPeriodStart: Date;
  /** Current billing period end */
  currentPeriodEnd: Date;
}

// ============================================================================
// Refund Types
// ============================================================================

/** Request to refund a payment */
export interface RefundRequest {
  /** Payment ID to refund */
  paymentId: string;
  /** Amount to refund (omit for full refund) */
  amount?: number;
  /** Reason for refund */
  reason?: string;
}

/** Result of refund operation */
export interface RefundResult {
  /** Refund ID */
  id: string;
  /** Original payment ID */
  paymentId: string;
  /** Amount refunded */
  amount: number;
  /** Refund status */
  status: RefundStatus;
}

// ============================================================================
// Provider Config Types
// ============================================================================

/** Stripe provider configuration */
export interface StripeProviderConfig {
  /** Stripe secret key */
  secretKey: string;
  /** API version (optional, defaults to latest) */
  apiVersion?: string;
  /** Webhook signing secret */
  webhookSecret?: string;
  /** Request timeout in ms */
  timeout?: number;
  /** Max retry attempts */
  maxNetworkRetries?: number;
}

/** Solana provider configuration */
export interface SolanaProviderConfig {
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Escrow program ID (optional) */
  escrowProgramId?: string;
  /** Commitment level */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/** Payment service configuration */
export interface PaymentServiceConfig {
  /** Provider configurations */
  providers: {
    stripe?: StripeProviderConfig;
    solana?: SolanaProviderConfig;
  };
  /** Default provider for fiat currencies */
  defaultFiatProvider?: 'stripe';
  /** Default provider for crypto currencies */
  defaultCryptoProvider?: 'solana';
}

// ============================================================================
// Webhook Types
// ============================================================================

/** Payment event types */
export type PaymentEventType =
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.requires_action'
  | 'escrow.created'
  | 'escrow.released'
  | 'escrow.refunded'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'refund.created'
  | 'refund.succeeded';

/** Unified payment event */
export interface PaymentEvent {
  /** Event type */
  type: PaymentEventType;
  /** Which provider emitted this */
  provider: 'stripe' | 'solana';
  /** Event timestamp */
  timestamp: Date;
  /** Event payload */
  data: unknown;
}

/** Webhook handler function */
export type WebhookHandler = (event: PaymentEvent) => Promise<void>;
