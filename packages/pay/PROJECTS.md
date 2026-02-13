# packages/pay — Unified Payment Infrastructure

## Vision

One interface. Two worlds. No lock-in.

```typescript
// Same API, different rails
await pay.charge({ amount: 1500, currency: 'USD', to: 'did:imajin:merchant123' });
await pay.charge({ amount: 0.5, currency: 'SOL', to: 'did:imajin:merchant123' });
```

## Why This Package

The sovereign stack needs payment infrastructure that:

1. **Works today** — Stripe for fiat (cards, subscriptions, checkout)
2. **Works tomorrow** — Solana for crypto (SOL, USDC, future MJN)
3. **Abstracts the rails** — Apps don't care which provider settles
4. **Preserves identity** — DIDs link payments to identity layer

Traditional finance says: "Too small, too informal, too costly to serve"
Solana says: "Your $1 transaction costs $0.00025. Build your economy."

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   @imajin/pay                       │
├─────────────────────────────────────────────────────┤
│  PaymentService                                     │
│  ├── charge(params)        → unified payment API   │
│  ├── checkout(params)      → hosted checkout flow  │
│  ├── escrow(params)        → trustless holding     │
│  ├── release(escrowId)     → release from escrow   │
│  ├── refund(paymentId)     → reverse payment       │
│  └── subscribe(params)     → recurring payments    │
├─────────────────────────────────────────────────────┤
│  Providers                                          │
│  ├── stripe    → Stripe API (fiat)                 │
│  ├── solana    → Solana RPC (SOL, USDC, SPL)       │
│  └── mjn       → MJN token (future, extends solana)│
├─────────────────────────────────────────────────────┤
│  Types                                              │
│  ├── Payment, Charge, Checkout, Escrow, Refund    │
│  ├── Subscription, Invoice, PaymentMethod         │
│  └── ProviderConfig, PaymentResult                │
└─────────────────────────────────────────────────────┘
```

## Core Types

```typescript
// packages/pay/src/types.ts

/** Supported payment currencies */
type FiatCurrency = 'USD' | 'CAD' | 'EUR' | 'GBP';
type CryptoCurrency = 'SOL' | 'USDC' | 'MJN';
type Currency = FiatCurrency | CryptoCurrency;

/** Payment recipient - DID or provider-specific ID */
type Recipient = 
  | { did: string }                    // Resolved via identity layer
  | { stripeAccountId: string }        // Direct Stripe Connect
  | { solanaAddress: string };         // Direct wallet

/** Unified charge request */
interface ChargeRequest {
  amount: number;                      // In base units (cents for fiat, lamports/etc for crypto)
  currency: Currency;
  to: Recipient;
  from?: string;                       // DID of payer (optional, derived from session)
  description?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;             // Prevent double-charges
}

/** Unified charge result */
interface ChargeResult {
  id: string;                          // Provider-specific payment ID
  provider: 'stripe' | 'solana';
  status: 'pending' | 'succeeded' | 'failed' | 'requires_action';
  amount: number;
  currency: Currency;
  fee?: number;                        // Transaction fee charged
  signature?: string;                  // Solana tx signature (if applicable)
  clientSecret?: string;               // Stripe client secret (if applicable)
  createdAt: Date;
  metadata?: Record<string, string>;
}

/** Hosted checkout flow */
interface CheckoutRequest {
  items: Array<{
    name: string;
    description?: string;
    amount: number;                    // Unit price in cents
    quantity: number;
    image?: string;
  }>;
  currency: FiatCurrency;              // Checkout only supports fiat for now
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

interface CheckoutResult {
  id: string;
  url: string;                         // Redirect URL for hosted checkout
  expiresAt: Date;
}

/** Escrow for trustless transactions */
interface EscrowRequest {
  amount: number;
  currency: Currency;
  from: string;                        // DID of depositor
  to: string;                          // DID of recipient (released to on completion)
  arbiter?: string;                    // DID of dispute resolver (optional)
  conditions?: {
    releaseAfter?: Date;               // Auto-release timestamp
    requireSignatures?: string[];      // DIDs that must sign to release
  };
  metadata?: Record<string, string>;
}

interface EscrowResult {
  id: string;
  provider: 'stripe' | 'solana';
  status: 'held' | 'released' | 'refunded' | 'disputed';
  amount: number;
  currency: Currency;
  from: string;
  to: string;
  createdAt: Date;
  expiresAt?: Date;
}

/** Subscription (Stripe-only for now) */
interface SubscriptionRequest {
  customerId: string;                  // Stripe customer ID or DID
  priceId: string;                     // Stripe price ID
  trialDays?: number;
  metadata?: Record<string, string>;
}

interface SubscriptionResult {
  id: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

/** Refund */
interface RefundRequest {
  paymentId: string;
  amount?: number;                     // Partial refund, or full if omitted
  reason?: string;
}

interface RefundResult {
  id: string;
  paymentId: string;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed';
}
```

## Provider Interface

```typescript
// packages/pay/src/providers/types.ts

interface PaymentProvider {
  name: 'stripe' | 'solana';
  
  /** Provider capabilities */
  capabilities: {
    charge: boolean;
    checkout: boolean;
    escrow: boolean;
    subscriptions: boolean;
    refunds: boolean;
  };
  
  /** Health check */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  
  /** Core operations */
  charge(request: ChargeRequest): Promise<ChargeResult>;
  checkout?(request: CheckoutRequest): Promise<CheckoutResult>;
  escrow?(request: EscrowRequest): Promise<EscrowResult>;
  releaseEscrow?(escrowId: string): Promise<EscrowResult>;
  refund?(request: RefundRequest): Promise<RefundResult>;
  
  /** Subscriptions (Stripe only) */
  createSubscription?(request: SubscriptionRequest): Promise<SubscriptionResult>;
  cancelSubscription?(subscriptionId: string): Promise<SubscriptionResult>;
}
```

## Stripe Provider

Maps to existing imajin-cli StripeService and imajin-web stripe-service:

```typescript
// packages/pay/src/providers/stripe.ts

import Stripe from 'stripe';
import type { PaymentProvider, ChargeRequest, ChargeResult } from './types';

interface StripeProviderConfig {
  secretKey: string;
  apiVersion?: string;
  webhookSecret?: string;
}

export class StripeProvider implements PaymentProvider {
  name = 'stripe' as const;
  capabilities = {
    charge: true,
    checkout: true,
    escrow: true,          // Via Payment Intents with capture_method: manual
    subscriptions: true,
    refunds: true,
  };
  
  private stripe: Stripe;
  
  constructor(config: StripeProviderConfig) {
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: config.apiVersion || '2025-09-30.clover',
    });
  }
  
  async healthCheck() {
    try {
      await this.stripe.accounts.retrieve();
      return { healthy: true };
    } catch (error) {
      return { healthy: false, message: error.message };
    }
  }
  
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    // Resolve recipient to Stripe customer/connected account
    const recipient = await this.resolveRecipient(request.to);
    
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: request.amount,
      currency: request.currency.toLowerCase(),
      customer: recipient.customerId,
      description: request.description,
      metadata: request.metadata,
      automatic_payment_methods: { enabled: true },
    }, {
      idempotencyKey: request.idempotencyKey,
    });
    
    return {
      id: paymentIntent.id,
      provider: 'stripe',
      status: this.mapStatus(paymentIntent.status),
      amount: paymentIntent.amount,
      currency: request.currency,
      clientSecret: paymentIntent.client_secret,
      createdAt: new Date(paymentIntent.created * 1000),
      metadata: paymentIntent.metadata,
    };
  }
  
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
  
  async escrow(request: EscrowRequest): Promise<EscrowResult> {
    // Create PaymentIntent with manual capture = escrow
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: request.amount,
      currency: this.isFiat(request.currency) ? request.currency.toLowerCase() : 'usd',
      capture_method: 'manual',
      metadata: {
        escrow: 'true',
        from_did: request.from,
        to_did: request.to,
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
    // ... map to EscrowResult
  }
  
  async refund(request: RefundRequest): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create({
      payment_intent: request.paymentId,
      amount: request.amount,
      reason: request.reason as any,
    });
    
    return {
      id: refund.id,
      paymentId: request.paymentId,
      amount: refund.amount,
      status: refund.status === 'succeeded' ? 'succeeded' : 'pending',
    };
  }
  
  // ... subscription methods, helper methods
}
```

## Solana Provider

For direct crypto payments (SOL, USDC, future MJN):

```typescript
// packages/pay/src/providers/solana.ts

import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import type { PaymentProvider, ChargeRequest, ChargeResult, EscrowRequest } from './types';

interface SolanaProviderConfig {
  rpcUrl: string;                      // e.g., 'https://api.mainnet-beta.solana.com'
  escrowProgramId?: string;            // Custom escrow program (optional)
}

export class SolanaProvider implements PaymentProvider {
  name = 'solana' as const;
  capabilities = {
    charge: true,
    checkout: false,                   // No hosted checkout for crypto
    escrow: true,                      // Via escrow program
    subscriptions: false,              // No native subscriptions
    refunds: false,                    // Blockchain is immutable
  };
  
  private connection: Connection;
  
  constructor(config: SolanaProviderConfig) {
    this.connection = new Connection(config.rpcUrl);
  }
  
  async healthCheck() {
    try {
      const slot = await this.connection.getSlot();
      return { healthy: true, message: `Slot: ${slot}` };
    } catch (error) {
      return { healthy: false, message: error.message };
    }
  }
  
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    // For SOL transfers, build and return unsigned transaction
    // Caller signs with their wallet
    
    const recipient = this.resolveRecipient(request.to);
    
    if (request.currency === 'SOL') {
      return this.chargeSOL(request, recipient);
    } else if (request.currency === 'USDC' || request.currency === 'MJN') {
      return this.chargeSPL(request, recipient);
    }
    
    throw new Error(`Unsupported currency: ${request.currency}`);
  }
  
  private async chargeSOL(request: ChargeRequest, to: PublicKey): Promise<ChargeResult> {
    // Return transaction to be signed by caller
    // Actual signing happens in the app layer (wallet adapter)
    
    return {
      id: `pending-${Date.now()}`,
      provider: 'solana',
      status: 'requires_action',       // Needs wallet signature
      amount: request.amount,
      currency: 'SOL',
      createdAt: new Date(),
      metadata: {
        ...request.metadata,
        recipientAddress: to.toString(),
        instruction: 'sign_and_send',  // Signal to frontend
      },
    };
  }
  
  async escrow(request: EscrowRequest): Promise<EscrowResult> {
    // Use Solana escrow program (e.g., custom or existing like Streamflow)
    // Create escrow account, deposit funds, set release conditions
    
    // For now, return placeholder - actual implementation needs escrow program
    throw new Error('Solana escrow not yet implemented');
  }
}
```

## Unified Service

```typescript
// packages/pay/src/service.ts

import type { 
  PaymentProvider, 
  ChargeRequest, 
  ChargeResult,
  CheckoutRequest,
  CheckoutResult,
  EscrowRequest,
  EscrowResult,
  RefundRequest,
  RefundResult,
  Currency,
} from './types';

interface PaymentServiceConfig {
  providers: {
    stripe?: StripeProviderConfig;
    solana?: SolanaProviderConfig;
  };
  defaultFiatProvider?: 'stripe';
  defaultCryptoProvider?: 'solana';
}

export class PaymentService {
  private providers: Map<string, PaymentProvider> = new Map();
  private config: PaymentServiceConfig;
  
  constructor(config: PaymentServiceConfig) {
    this.config = config;
    
    if (config.providers.stripe) {
      this.providers.set('stripe', new StripeProvider(config.providers.stripe));
    }
    if (config.providers.solana) {
      this.providers.set('solana', new SolanaProvider(config.providers.solana));
    }
  }
  
  /** Route to appropriate provider based on currency */
  private getProvider(currency: Currency): PaymentProvider {
    const isCrypto = ['SOL', 'USDC', 'MJN'].includes(currency);
    const providerName = isCrypto 
      ? (this.config.defaultCryptoProvider || 'solana')
      : (this.config.defaultFiatProvider || 'stripe');
    
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} not configured`);
    }
    return provider;
  }
  
  /** Unified charge - routes to correct provider */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const provider = this.getProvider(request.currency);
    return provider.charge(request);
  }
  
  /** Hosted checkout flow (Stripe only) */
  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    const provider = this.providers.get('stripe');
    if (!provider?.checkout) {
      throw new Error('Checkout requires Stripe provider');
    }
    return provider.checkout(request);
  }
  
  /** Create escrow */
  async escrow(request: EscrowRequest): Promise<EscrowResult> {
    const provider = this.getProvider(request.currency);
    if (!provider.escrow) {
      throw new Error(`Provider ${provider.name} does not support escrow`);
    }
    return provider.escrow(request);
  }
  
  /** Release escrow */
  async releaseEscrow(escrowId: string, provider: 'stripe' | 'solana'): Promise<EscrowResult> {
    const p = this.providers.get(provider);
    if (!p?.releaseEscrow) {
      throw new Error(`Provider ${provider} does not support escrow release`);
    }
    return p.releaseEscrow(escrowId);
  }
  
  /** Refund payment */
  async refund(request: RefundRequest, provider: 'stripe'): Promise<RefundResult> {
    const p = this.providers.get(provider);
    if (!p?.refund) {
      throw new Error(`Provider ${provider} does not support refunds`);
    }
    return p.refund(request);
  }
  
  /** Health check all providers */
  async healthCheck(): Promise<Record<string, { healthy: boolean; message?: string }>> {
    const results: Record<string, any> = {};
    for (const [name, provider] of this.providers) {
      results[name] = await provider.healthCheck();
    }
    return results;
  }
}
```

## Integration with Identity (packages/auth)

Payments link to DIDs:

```typescript
// Example: charge a DID, resolve to provider-specific ID
import { PaymentService } from '@imajin/pay';
import { resolve } from '@imajin/auth';

const pay = new PaymentService({ /* config */ });

// Charge by DID - service resolves to Stripe customer or Solana address
const result = await pay.charge({
  amount: 1500,
  currency: 'USD',
  to: { did: 'did:imajin:abc123' },
  description: 'DYKIL Premium Features',
});

// DID resolution happens internally:
// 1. Lookup DID document
// 2. Find payment endpoint (stripe customer ID or solana address)
// 3. Route to appropriate provider
```

## Webhooks

For Stripe async events:

```typescript
// packages/pay/src/webhooks.ts

import type Stripe from 'stripe';

type WebhookHandler = (event: PaymentEvent) => Promise<void>;

interface PaymentEvent {
  type: 'payment.succeeded' | 'payment.failed' | 'escrow.released' | 'subscription.created' | 'subscription.canceled';
  provider: 'stripe' | 'solana';
  data: any;
}

export function createStripeWebhookHandler(
  secretKey: string,
  webhookSecret: string,
  handlers: Partial<Record<PaymentEvent['type'], WebhookHandler>>
) {
  return async (payload: string | Buffer, signature: string) => {
    const stripe = new Stripe(secretKey);
    const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    
    const mapped = mapStripeEvent(event);
    if (mapped && handlers[mapped.type]) {
      await handlers[mapped.type]!(mapped);
    }
  };
}
```

## File Structure

```
packages/pay/
├── PROJECTS.md              # This file
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts             # Public exports
│   ├── types.ts             # All type definitions
│   ├── service.ts           # PaymentService (unified API)
│   ├── webhooks.ts          # Webhook handlers
│   └── providers/
│       ├── index.ts         # Provider exports
│       ├── types.ts         # Provider interface
│       ├── stripe.ts        # Stripe implementation
│       └── solana.ts        # Solana implementation
└── test/
    ├── stripe.test.ts
    └── solana.test.ts
```

## Dependencies

```json
{
  "dependencies": {
    "stripe": "^17.0.0",
    "@solana/web3.js": "^1.95.0",
    "@solana/spl-token": "^0.4.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

## Existing Code to Extract

### From imajin-cli (StripeService)
- Health check pattern
- Customer management
- Payment intent creation
- Subscription handling
- Business context mapping (adapt for DID mapping)

### From imajin-web (stripe-service)
- Checkout session creation
- Deposit handling (escrow pattern)
- Webhook verification
- Refund processing

### From imajin-token docs
- Solana settlement concepts
- MJN token integration (future)
- Escrow program design

## Migration Path

1. **Phase 1**: Extract Stripe code into provider
   - Port imajin-web checkout functions
   - Port imajin-cli payment methods
   - Unified types

2. **Phase 2**: Add Solana provider
   - Basic SOL transfers
   - USDC transfers (SPL token)
   - Wallet adapter integration

3. **Phase 3**: Identity integration
   - DID → payment address resolution
   - Signed payment receipts
   - .fair revenue splits

4. **Phase 4**: MJN token (when launched)
   - SPL token transfer
   - Escrow program
   - Curation rewards splits

## Usage in Apps

```typescript
// apps/dykil/lib/pay.ts
import { PaymentService } from '@imajin/pay';

export const pay = new PaymentService({
  providers: {
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY!,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    },
  },
});

// apps/shop/lib/pay.ts (with crypto)
import { PaymentService } from '@imajin/pay';

export const pay = new PaymentService({
  providers: {
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY!,
    },
    solana: {
      rpcUrl: process.env.SOLANA_RPC_URL!,
    },
  },
});
```

---

## The Bigger Picture

This package is the **settlement layer** of the sovereign stack:

| Layer | Package | Purpose |
|-------|---------|---------|
| Identity | @imajin/auth | Who you are (DIDs, signatures) |
| **Settlement** | **@imajin/pay** | **How value moves (Stripe, Solana)** |
| Attribution | @imajin/fair | Who made what, who gets paid |
| Orchestration | imajin-cli | How agents do things |

Every payment is:
- **Signed** (by a DID, proving authorization)
- **Typed** (human vs agent)
- **Trackable** (on-chain or in Stripe)
- **Sovereign** (no platform lock-in)

---

*Build the rails. Own the rails.*
