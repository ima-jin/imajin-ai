// ============================================================================
// .fair v1.0 types (preserved — backward compatible)
// ============================================================================

export interface FairSignature {
  algorithm: 'ed25519';
  value: string; // 128 hex chars (64 bytes)
  publicKeyRef: string; // DID of the signer
}

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

export interface FairManifestV1_0 {
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

export interface Money {
  amount: number; // non-negative integer, minor units (cents)
  currency: string; // ISO 4217 3-letter uppercase or 'MJNX'
}

export interface DidShareEntry {
  did?: string;
  role: string;
  share: number;
  name?: string;
  note?: string;
  chainProof?: {
    verified: boolean;
    verifiedAt?: string;
  };
}

export type DidShareList = DidShareEntry[];

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

export interface FairTransferV1_1 {
  allowed: boolean;
  requiresAttribution?: boolean;
  price?: Money;
  resaleRoyaltyBps?: number;
  // v1.0 backward compat padding
  refundable?: boolean;
  faceValueCap?: boolean;
  resaleRoyalty?: number;
}

export interface FairAccessV1_1 {
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

export interface SignedFairManifest extends FairManifestV1_1 {
  signature: Signature;
}

export type SettlementScheme = 'x402' | 'stripe-link' | 'mjnx-direct' | 'solana-pay' | 'lightning';

export interface SettlementConfig {
  endpoint?: string;             // override convention
  schemes?: SettlementScheme[];  // override server's default list
  fallback?: SettlementScheme;   // preferred for human checkout
}

export interface FairManifestV1_1 {
  fair: string; // "1.1"
  version: '1.1';
  id: string;
  type: string;
  owner: string;
  created: string;
  source?: string;
  access: FairAccessV1_1 | "public" | "private";
  transfer?: FairTransferV1_1;
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
  // backward compat aliases
  distributions?: DidShareList;
  chain?: DidShareList;
  platformSignature?: FairSignature;
}

/** Union type — narrow with `'version' in m && m.version === '1.1'` */
export type FairManifest = FairManifestV1_0 | FairManifestV1_1;

// ============================================================================
// Type guards
// ============================================================================

export function isFairManifestV1_1(m: FairManifest | null | undefined): m is FairManifestV1_1 {
  return !!m && typeof m === 'object' && 'version' in m && m.version === '1.1';
}
