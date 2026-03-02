/**
 * @imajin/auth
 * 
 * Sovereign identity for humans and agents.
 * 
 * @example
 * import { generateKeypair, createIdentity, sign, verify } from '@imajin/auth';
 * 
 * // Generate a new identity
 * const keypair = generateKeypair();
 * const identity = createIdentity(keypair.publicKey, 'human');
 * 
 * // Sign a message
 * const signed = await sign({ action: 'hello' }, keypair.privateKey, identity);
 * 
 * // Verify it
 * const result = await verify(signed, keypair.publicKey);
 * console.log(result.valid); // true
 */

// Types
export * from './types';
export * from './types/node';

// Constants (TTLs, rate limits)
export * from './constants';

// Core signing/verification
export { 
  sign, 
  signSync, 
  generateKeypair, 
  getPublicKey, 
  canonicalize,
  createChallenge,
} from './sign';

export { 
  verify, 
  verifySync, 
  verifyChallenge,
  verifySignatureOnly,
  isValidMessageStructure,
  type VerifyOptions,
} from './verify';

// Crypto utilities (for advanced use)
export {
  bytesToHex,
  hexToBytes,
  stringToBytes,
  isValidPublicKey,
  isValidPrivateKey,
  isValidSignature,
} from './crypto';

// Keypair provider (convenience functions)
export {
  createDID,
  createIdentity,
  signMessage,
  signMessageSync,
  verifyMessage,
  verifyMessageSync,
  storeKeypair,
  loadKeypair,
  deleteKeypair,
  listKeypairs,
  isValidDID,
  getPublicKeyPrefixFromDID,
} from './providers/keypair';

// Permission system
export {
  canDo,
  requiredTier,
  hasTier,
  type Action,
  type Tier,
} from './permissions';

// Middleware (Next.js)
export {
  requireAuth as requireAuthMiddleware,
  requireHardDID as requireHardDIDMiddleware,
  requireGraphMember as requireGraphMemberMiddleware,
  errorResponse,
  type AuthSession,
  type AuthResult,
  type AuthError,
} from './middleware/nextjs';
