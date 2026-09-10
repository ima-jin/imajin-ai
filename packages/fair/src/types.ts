// ============================================================================
// .fair v1.0 types (preserved — backward compatible)
// ============================================================================

export interface FairSignature {
  algorithm: 'ed25519';
  value: string; // 128 hex chars (64 bytes)
  publicKeyRef: string; // DID of the signer
}

/**
 * A single `.fair` attribution/distribution/chain entry — shared by both
 * `FairManifestV10` and `FairManifestV11` (#1712: this used to also be
 * declared separately as `DidShareEntry`; the two were never structurally
 * different, so this is now the single canonical shape for both versions).
 */
export interface FairEntry {
  did?: string;
  role: string;
  share: number;
  note?: string;
  name?: string;
  chainProof?: {
    verified: boolean;
    verifiedAt?: string;
  };
}

export interface FairFee {
  role: string;
  name: string;
  rateBps: number;
  minRateBps?: number;
  fixedCents: number;
}

export interface FairTransfer {
  allowed: boolean;
  refundable?: boolean;
  resaleRoyalty?: number;
  faceValueCap?: boolean;
  // v1.1 optional fields for union compatibility
  requiresAttribution?: boolean;
  price?: Money;
  resaleRoyaltyBps?: number;
}

export interface FairAccess {
  type: "public" | "private" | "trust-graph" | "conversation";
  allowedDids?: string[];
  conversationDid?: string;
}

export interface FairIntegrity {
  hash: string;
  size: number;
}

export interface FairIntent {
  purpose: string;
  constraints?: Record<string, unknown>;
}

/** .fair manifest schema v1.0 — see `version` field */
export interface FairManifestV10 {
  fair: string; // "1.0"
  id: string;
  type: string;
  owner: string;
  created: string;
  source?: string;
  access: FairAccess | "public" | "private";
  transfer?: FairTransfer;
  fees?: FairFee[];
  attribution: FairEntry[];
  distributions?: FairEntry[];
  integrity?: FairIntegrity;
  terms?: string;
  intent?: FairIntent;
  signature?: FairSignature;
  platformSignature?: FairSignature;
  version?: string;
  chain?: FairEntry[];
}

// ============================================================================
// .fair v1.1 types (new)
// ============================================================================

// Money used to be defined here directly. It now lives in `@imajin/money`
// (#1950) — re-exported rather than duplicated so there is exactly one
// definition. The shape is unchanged (`{ amount: number, currency: string }`,
// non-negative integer minor units for this package's own purposes), so
// every existing object-literal call site below still type-checks as-is.
// (`import type` + `export type` rather than a single `export type {...}
// from ...`, since the interfaces further down this file reference `Money`
// directly — a bare re-export doesn't introduce a local binding.)
import type { Money } from '@imajin/money';
export type { Money };

// `DidShareEntry` used to be a hand-maintained duplicate of `FairEntry`
// (#1712) — same six fields (`did?`, `role`, `share`, `name?`, `note?`,
// `chainProof?`), just declared a second time for the v1.1 manifest. There
// was never a v1.0/v1.1 distinction at the *entry* level — only at the
// *manifest* level (`FairManifestV10` vs `FairManifestV11` genuinely
// differ) — so `FairEntry` is now the one shape both versions share.
export type DidShareList = FairEntry[];

export interface FairDistributionRight {
  mode: string;
  price?: Money;
  splits?: DidShareList;
  quote?: { maxPercent?: number; maxWords?: number };
  sampling?: { allowed?: string; share?: number };
  sync?: { allowed?: string };
}

export interface FairTraining {
  allowed: boolean;
  grants?: Array<{ purpose: string; scope?: string; expires?: string }>;
}

export interface FairCommercial {
  allowed: boolean;
  contactRequired?: boolean;
}

/** .fair manifest schema v1.1 — see `version` field */
export interface FairTransferV11 {
  allowed: boolean;
  requiresAttribution?: boolean;
  price?: Money;
  resaleRoyaltyBps?: number;
  splits?: DidShareList;
  // v1.0 backward compat padding
  refundable?: boolean;
  faceValueCap?: boolean;
  resaleRoyalty?: number;
}

/** .fair manifest schema v1.1 — see `version` field */
export interface FairAccessV11 {
  type: "public" | "private" | "trust-graph" | "conversation";
  allowedDids?: string[];
  conversationDid?: string;
}

export interface Signature {
  signer: string;
  alg: 'ed25519';
  value: string; // base64url
  signedAt: string; // ISO 8601
}

export interface SignedFairManifest extends FairManifestV11 {
  signature: Signature;
}

export type SettlementScheme = 'x402' | 'stripe-link' | 'mjnx-direct' | 'solana-pay' | 'lightning';

export interface SettlementConfig {
  endpoint?: string;             // override convention
  schemes?: SettlementScheme[];  // override server's default list
  fallback?: SettlementScheme;   // preferred for human checkout
}

/**
 * One-directional provenance reference (#1886): a `.fair` manifest may cite
 * the attestation facts that justify its distribution, but attestations
 * never point back at money. `attestationId` is the id of a row in
 * `auth.attestations` (e.g. an `intro_proposed` / `consent_given` /
 * `intro_made` / `value_realized` record); `type` mirrors that
 * attestation's own `type` for cheap filtering without a lookup.
 */
export interface FairProvenanceRef {
  attestationId: string;
  type: string;
}

/** .fair manifest schema v1.1 — see `version` field */
export interface FairManifestV11 {
  fair: string; // "1.1"
  version: '1.1';
  id: string;
  type: string;
  owner: string;
  created: string;
  source?: string;
  access: FairAccessV11 | "public" | "private";
  transfer?: FairTransferV11;
  fees?: FairFee[];
  attribution: DidShareList;
  distribution?: {
    reproduction?: FairDistributionRight;
    streaming?: FairDistributionRight;
    derivative?: FairDistributionRight;
    syndication?: FairDistributionRight;
  };
  training?: FairTraining;
  commercial?: FairCommercial;
  integrity?: FairIntegrity;
  terms?: string;
  intent?: FairIntent;
  signature?: Signature;
  tipping?: { enabled: boolean };
  settlement?: SettlementConfig;
  // Money points at facts; facts never point at money (#1886). Optional —
  // most manifests (media, tickets, courses) have no attestation-chain
  // dependency and omit this entirely.
  provenance?: FairProvenanceRef[];
  // backward compat aliases
  distributions?: DidShareList;
  chain?: DidShareList;
  platformSignature?: FairSignature;
}

/** Union type — narrow with `'version' in m && m.version === '1.1'` */
export type FairManifest = FairManifestV10 | FairManifestV11;

// ============================================================================
// Type guards
// ============================================================================

export function isFairManifestV11(m: FairManifest | null | undefined): m is FairManifestV11 {
  return !!m && typeof m === 'object' && 'version' in m && m.version === '1.1';
}
