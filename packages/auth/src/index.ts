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
export * from './types.js';

// Core signing/verification
export { 
  sign, 
  signSync, 
  generateKeypair, 
  getPublicKey, 
  canonicalize,
  createChallenge,
} from './sign.js';

export { 
  verify, 
  verifySync, 
  verifyChallenge,
  verifySignatureOnly,
  isValidMessageStructure,
  type VerifyOptions,
} from './verify.js';

// Crypto utilities (for advanced use)
export {
  bytesToHex,
  hexToBytes,
  stringToBytes,
  isValidPublicKey,
  isValidPrivateKey,
  isValidSignature,
} from './crypto.js';

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
} from './providers/keypair.js';
