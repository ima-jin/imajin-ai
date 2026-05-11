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
} from './types';
export { isFairManifestV1_1 } from './types';

export type { FairTemplate, TemplateConfig } from './templates';
export { templates } from './templates';

export { validateManifest, isValidManifest } from './validate';
export { createManifest } from './create';
export { canonicalize, canonicalizeForSigning } from './canonical';
export { signManifest, verifyManifest, platformSign, verifyPlatformSignature } from './sign';
export { FairAccordion } from './components/FairAccordion';
export { FairEditor } from './components/FairEditor';
export type { FairEditorProps } from './components/FairEditor';

export {
  PROTOCOL_FEE_BPS,
  PROTOCOL_DID,
  NODE_FEE_MIN_BPS,
  NODE_FEE_MAX_BPS,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_MIN_BPS,
  BUYER_CREDIT_MAX_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
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
