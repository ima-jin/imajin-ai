// Protocol fee — governance-controlled, not configurable
export const PROTOCOL_FEE_BPS = 100;  // 1.0%
export const PROTOCOL_DID = "did:imajin:c6e6c109db4a1cc52995c0836f73cc6833d7e4624bc86e048118d72820873213";

// Payment processor fees (estimate — actual fees vary by card type)
// Using international rate (3.7%) as safe estimate to avoid platform losses.
// Domestic is 2.9%, international +0.8%, currency conversion +2%.
// Webhook reconciles with actual Stripe fee via balance_transaction.
export const STRIPE_RATE_BPS = 370;       // 3.7% (domestic 2.9% + international 0.8%)
export const STRIPE_MIN_RATE_BPS = 290;   // 2.9% (domestic cards)
export const STRIPE_FIXED_CENTS = 30;     // CA$0.30 per transaction

// Bounds — node operators must stay within these
export const NODE_FEE_MIN_BPS = 25;
export const NODE_FEE_MAX_BPS = 200;
export const NODE_FEE_DEFAULT_BPS = 50;      // 0.5%
export const BUYER_CREDIT_MIN_BPS = 25;
export const BUYER_CREDIT_MAX_BPS = 200;
export const BUYER_CREDIT_DEFAULT_BPS = 25;  // 0.25%
