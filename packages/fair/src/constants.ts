// Protocol fee — governance-controlled, not configurable
export const PROTOCOL_FEE_BPS = 100;  // 1.0%
export const PROTOCOL_DID = "did:imajin:c6e6c109db4a1cc52995c0836f73cc6833d7e4624bc86e048118d72820873213";

// Platform fee — money split, not creative credit
export const PLATFORM_FEE_BPS = 100;  // 1.0%
export const PLATFORM_DID = PROTOCOL_DID;  // same recipient as protocol for now

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
export const SCOPE_FEE_DEFAULT_BPS = 25;     // 0.25%

// #2419 — well-known remittance-authority placeholder DID. A creditor
// label only (`taxes[].remitTo`) — never a settlement payee, never
// resolved to a real identity/keypair.
export const AUTHORITY_DID_CA_CRA = 'did:imajin:authority:ca-cra';

/** Short display labels for well-known remittance-authority DIDs (#2439 — what #2419 shows next to a tax line, e.g. "collected for CRA"). */
export const AUTHORITY_LABELS: Readonly<Record<string, string>> = {
  [AUTHORITY_DID_CA_CRA]: 'CRA',
};

const AUTHORITY_DID_PREFIX = 'did:imajin:authority:';

/**
 * Display label for a `taxes[].remitTo` authority DID: the well-known short
 * label when there is one (`…:ca-cra` → `CRA`), else the upper-cased slug of
 * any other `did:imajin:authority:*` DID, else `null` (not an authority DID —
 * the caller picks its own fallback).
 */
export function authorityLabel(remitTo: string): string | null {
  const known = AUTHORITY_LABELS[remitTo];
  if (known) return known;
  if (!remitTo.startsWith(AUTHORITY_DID_PREFIX)) return null;
  const slug = remitTo.slice(AUTHORITY_DID_PREFIX.length);
  return slug ? slug.toUpperCase() : null;
}
