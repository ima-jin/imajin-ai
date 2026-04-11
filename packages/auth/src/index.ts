export type { Identity, AuthResult, AuthError, IdentityType, Keypair, SignedMessage, VerificationResult } from "./types";
export { requireAuth } from "./require-auth";
export type { AuthOptions } from "./require-auth";
export { requireAdmin } from "./require-admin";
export { optionalAuth } from "./optional-auth";
export { getSession } from "./session";
export type { SessionOptions } from "./session";
export { requireHardDID } from "./require-hard-did";
export { requireEstablishedDID } from "./require-established-did";
export { canonicalize, sign, signSync } from "./sign";
export { verify, isValidMessageStructure } from "./verify";
export * as crypto from "./crypto";
export { hexToBytes, stringToBytes, bytesToHex, bytesToMultibase, multibaseToPubkey, hexToMultibase, multibaseToHex, generateKeypair, generatePrivateKey, getPublicKey, extractPrivateKeySeed, verifySync, isValidPublicKey, isValidPrivateKey, isValidSignature } from "./crypto";
export type { Attestation, AttestationType } from "./types/attestation";
export { ATTESTATION_TYPES } from "./types/attestation";
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
export { getEmailForDid, getDidForEmail } from "./credentials";
export { emitAttestation } from "./emit-attestation";
