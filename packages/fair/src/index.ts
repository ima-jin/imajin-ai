export type {
  FairEntry,
  FairFee,
  FairTransfer,
  FairAccess,
  FairIntegrity,
  FairIntent,
  FairManifest,
  FairManifestV1_0,
  FairManifestV1_1,
  FairSignature,
  // v1.1 new types
  Money,
  DidShareEntry,
  DidShareList,
  FairDistributionRight,
  FairTraining,
  FairCommercial,
  FairTransferV1_1,
  FairAccessV1_1,
  Signature,
  SignedFairManifest,
  SettlementScheme,
  SettlementConfig,
  FairProvenanceRef,
} from './types';
export { isFairManifestV1_1 } from './types';

export type { FairTemplate, TemplateConfig } from './templates';
export { templates, getDefaultManifest } from './templates';

export { validateManifest, isValidManifest } from './validate';
// createManifest removed — use getDefaultManifest() or buildFairManifest() instead
export { canonicalize, canonicalizeForSigning } from './canonical';
export { signManifest, verifyManifest, platformSign, verifyPlatformSignature } from './sign';
// FairAccordion/FairEditor live in ./react.ts, not here. Both carry their own
// 'use client' directive, which only survives bundling when they are the sole
// content of their own output file — re-exporting them from this entry would
// merge their code into dist/index.js and lose the client boundary, breaking
// every server-only consumer (see #1574).

export {
  PROTOCOL_FEE_BPS,
  PROTOCOL_DID,
  NODE_FEE_MIN_BPS,
  NODE_FEE_MAX_BPS,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_MIN_BPS,
  BUYER_CREDIT_MAX_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
  SCOPE_FEE_DEFAULT_BPS,
  STRIPE_RATE_BPS,
  STRIPE_MIN_RATE_BPS,
  STRIPE_FIXED_CENTS,
} from './constants';

export { buildFairManifest } from './buildManifest';
export type { FairFeeManifest } from './buildManifest';

export {
  calculateAgentInteractionCost,
  validateAgentPricingManifest,
  isValidAgentPricingManifest,
  buildDefaultAgentPricingManifest,
} from './agent-pricing';
export type {
  AgentPricingManifest,
  AgentCostBreakdown,
} from './agent-pricing';

export { upgradeToV1_1 } from './upgrade';

export { build402Response } from './http-402';
export type { Build402ResponseOpts, Fair402Response, FairAction } from './http-402';

export { signReceipt, verifyReceipt, loadSigningKey, loadVerifyKey, receiptExpiryForAction } from './receipt';
export type { ReceiptPayload } from './receipt';

export { verifyManifestFromAsset } from './verify-from-asset';
export type {
  VerificationResult,
  VerifyManifestFromAssetOptions,
  FetchResponse,
} from './verify-from-asset';

// ── Disclosure engine (#1453) ──────────────────────────────────────────────────
export type { FairReleaseTier, FairFieldKey } from './disclosure';
export {
  FAIR_RELEASE_TIERS,
  TIER_RANK,
  FAIR_FLOOR_FIELDS,
  deriveReleaseTier,
  composeEffectivePolicy,
  applyDisclosureGates,
  parseSubjectGates,
} from './disclosure';
export type {
  FieldClassification,
  FieldOverlayEntry,
  FairDisclosureOverlay,
  EffectiveFieldPolicy,
  EffectivePolicy,
  WithheldAttestation,
  ApplyGatesResult,
} from './disclosure';

// ── Settlement fee-math (#1453) ────────────────────────────────────────────────
export { computeFeeCents, resolveSettlementChain, DEFAULT_SELLER_ROLES } from './settlement';
export type {
  FairSettlementEntry,
  ResolvedChainEntry,
  ResolveChainOptions,
  ResolvedChain,
} from './settlement';

// ── Intro-attribution .fair template (#1886) ───────────────────────────────────
export {
  VALUE_REALIZED_ATTESTATION_TYPE,
  INTRO_MADE_ATTESTATION_TYPE,
  INTRO_ATTRIBUTION_MANIFEST_TYPE,
  INTRO_ATTRIBUTION_ROLES,
  DEFAULT_INTRO_ATTRIBUTION_SPLIT_BPS,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  validateIntroAttributionSplitBps,
  isWithinAttributionWindow,
  validateIntroAttributionProvenance,
  buildIntroAttributionManifest,
  introAttributionSettlementChain,
  isIntroAttributionManifest,
} from './intro-attribution';
export type {
  IntroAttributionRole,
  IntroAttributionSplitBps,
  SplitValidationResult,
  AttributionWindowParams,
  AttestationFact,
  ProvenanceGateResult,
  BuildIntroAttributionManifestParams,
  IntroAttributionChainEntry,
} from './intro-attribution';
