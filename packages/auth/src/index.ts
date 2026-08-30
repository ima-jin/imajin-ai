export type { Identity, AuthResult, AuthError, IdentityType, Keypair, SignedMessage, VerificationResult } from "./types";
export { requireAuth } from "./require-auth";
export type { AuthOptions } from "./require-auth";
export { requireAdmin } from "./require-admin";
export { optionalAuth } from "./optional-auth";
export { getSession } from "./session";
export type { SessionOptions } from "./session";
export { requireHardDID } from "./require-hard-did";
export { requireEstablishedDID } from "./require-established-did";
export { isVerifiedTier, isEstablishedTier, isStewardTier, isOperatorTier, normalizeTier } from "./tiers";
export type { IdentityTier } from "./tiers";
export { canonicalize, sign, signSync } from "./sign";
export { verify, isValidMessageStructure } from "./verify";
export * as crypto from "./crypto";
export { hexToBytes, stringToBytes, bytesToHex, bytesToMultibase, multibaseToPubkey, hexToMultibase, multibaseToHex, generateKeypair, generatePrivateKey, getPublicKey, extractPrivateKeySeed, verifySync, isValidPublicKey, isValidPrivateKey, isValidSignature } from "./crypto";
export type { Attestation, AttestationType, NostrKeyBindingClaim } from "./types/attestation";
export { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from "./types/attestation";
export {
  INTRO_FUNNEL_ATTESTATION_TYPES,
  EVIDENCE_GRADED_ATTESTATION_TYPES,
  DISCLOSURE_SCOPES,
  DEFAULT_DISCLOSURE_SCOPE,
  EVIDENCE_GRADES,
  INTRO_FUNNEL_CONTEXT_TYPE,
  isIntroFunnelAttestationType,
  isDisclosureScope,
  evidenceGradeForAttestationStatus,
  expectedPrevEventType,
  verifyFunnelChainLink,
  verifyFunnelChain,
  funnelCorrelationContext,
} from "./intro-funnel";
export type {
  IntroFunnelAttestationType,
  DisclosureScope,
  EvidenceGrade,
  FunnelChainEvent,
  FunnelChainVerification,
} from "./intro-funnel";
export { verifyNostrSig, signNostrAttestation, getNostrPublicKey, nostrAttestationDigest } from "./nostr-crypto";
export { resolvePublicKey, createDbResolver, createHttpResolver } from "./resolve";
export type { ResolvedIdentity, PublicKeyResolver } from "./resolve";
export {
  TOKEN_TTL,
  CHALLENGE_TTL,
  NODE_REGISTRATION_TTL,
  NODE_HEARTBEAT_INTERVAL,
  NODE_STALE_THRESHOLD,
  NODE_UNREACHABLE_THRESHOLD,
  NODE_GRACE_PERIOD,
} from "./constants";
export type { NodeHeartbeat, NodeRegistration, NodeRegistrationRequest, NodeRegistrationResponse, NodeAttestation } from "./types/node";
export { getEmailForDid, getDidForEmail, resolveDidForEmail, resolveEmailForDid } from "./credentials";
export { emitAttestation } from "./emit-attestation";
export { SCOPES, validateScopes } from "./scopes";
export type { Scope } from "./scopes";
// Declarative scope vocabulary (#1253) — the single source of truth that SCOPES,
// the MCP capability ceiling, connector scope-manifest descriptors, and the
// connector-card UI list are all projections of. Client components should import
// from "@imajin/auth/scope-vocabulary" instead, to stay out of this server index.
export {
  SCOPE_VOCABULARY,
  CONNECTOR_DIDS,
  CONNECTOR_CHANNELS,
  isConnectorScope,
  deriveScopeReleaseTier,
  viewerForScope,
  uiLabelForScope,
  manifestLabelForScope,
  isCredentialFreeScope,
  isServiceEligibleScope,
  serviceEligibleScopes,
  scopeEntry,
  isKnownScope,
  scopesForConnector,
  scopesForSurface,
  allScopes,
} from "./scope-vocabulary";
export type {
  ConnectorId,
  CapabilitySurface,
  ScopeReleaseTier,
  ScopeClassification,
  ScopeVocabularyEntry,
  PlatformScopeEntry,
  ConnectorScopeEntry,
} from "./scope-vocabulary";
export {
  BROKER_RELEASE_MODES,
  BROKER_PREDICATE_NAMES,
  BROKER_TERM_VOCABULARIES,
  BROKER_FIELD_VOCABULARY,
  BROKER_PURPOSE_VOCABULARY,
  brokerFieldEntry,
  brokerPurposeEntry,
  brokerTermVocabulary,
  isKnownBrokerField,
  isKnownBrokerPurpose,
  isBrokerReleaseMode,
  isBrokerPredicateName,
  allBrokerPurposes,
  allBrokerFields,
  brokerFieldsForPurpose,
  isBrokerFieldAllowedForPurpose,
  brokerPredicatesForField,
  validateBrokerPurposeFields,
  normalizeBrokerTerm,
} from "./broker-consent-vocabulary";
export type {
  BrokerReleaseMode,
  BrokerPredicateName,
  BrokerFieldValueType,
  BrokerTermVocabularyId,
  BrokerTermEntry,
  BrokerTermVocabulary,
  BrokerFieldVocabularyEntry,
  BrokerFieldName,
  BrokerPurposeVocabularyEntry,
  BrokerPurpose,
} from "./broker-consent-vocabulary";
export { requireAppAuth } from "./require-app-auth";
export type { AppAuthContext, AppAuthResult } from "./require-app-auth";
export { resolveEffectiveDid } from "./resolve-effective-did";
export type { EffectiveDidResult } from "./resolve-effective-did";
export { resolveActingDid, resolveComposedBy } from "./acting-did";
