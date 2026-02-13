/**
 * Ed25519 Keypair Provider
 * 
 * The simplest auth: you have a keypair, you sign things.
 * No server state, works offline, fully sovereign.
 * 
 * This is the default provider for the Imajin identity system.
 */

import type { Keypair, Identity, SignedMessage, IdentityType } from '../types.js';
import * as crypto from '../crypto.js';
import { sign, signSync, canonicalize, createChallenge } from '../sign.js';
import { verify, verifySync, verifyChallenge } from '../verify.js';

// Re-export for convenience
export { sign, signSync, verify, verifySync, verifyChallenge, createChallenge };

/**
 * Generate a new Ed25519 keypair
 * 
 * @example
 * const keypair = generateKeypair();
 * console.log(keypair.publicKey);  // 64-char hex string
 * console.log(keypair.privateKey); // 64-char hex string (keep secret!)
 */
export function generateKeypair(): Keypair {
  return crypto.generateKeypair();
}

/**
 * Get public key from private key
 */
export function getPublicKey(privateKey: string): string {
  return crypto.getPublicKey(privateKey);
}

/**
 * Create a DID from a public key
 * 
 * Format: did:imajin:<first-16-chars-of-pubkey>
 * 
 * Note: The full public key is needed for verification,
 * the DID is just a short identifier.
 */
export function createDID(publicKey: string): string {
  if (!crypto.isValidPublicKey(publicKey)) {
    throw new Error('Invalid public key');
  }
  return `did:imajin:${publicKey.slice(0, 16)}`;
}

/**
 * Create a full identity from a public key
 * 
 * @example
 * const keypair = generateKeypair();
 * const identity = createIdentity(keypair.publicKey, 'human', {
 *   name: 'Ryan',
 *   email: 'ryan@imajin.ai',
 * });
 */
export function createIdentity(
  publicKey: string,
  type: IdentityType,
  metadata?: Identity['metadata']
): Identity {
  return {
    id: createDID(publicKey),
    type,
    publicKey,
    metadata,
    createdAt: new Date(),
  };
}

/**
 * Sign a message with a keypair
 * 
 * @example
 * const signed = await signMessage(
 *   { action: 'purchase', itemId: 'unit-8x8x8' },
 *   keypair.privateKey,
 *   identity
 * );
 */
export async function signMessage<T>(
  payload: T,
  privateKey: string,
  identity: Pick<Identity, 'id' | 'type'>
): Promise<SignedMessage<T>> {
  return sign(payload, privateKey, identity);
}

/**
 * Synchronous version of signMessage
 */
export function signMessageSync<T>(
  payload: T,
  privateKey: string,
  identity: Pick<Identity, 'id' | 'type'>
): SignedMessage<T> {
  return signSync(payload, privateKey, identity);
}

/**
 * Verify a signed message against a public key
 * 
 * @example
 * const result = await verifyMessage(signedMessage, publicKey);
 * if (result.valid) {
 *   // Message is authentic and from the identity
 * }
 */
export async function verifyMessage(
  message: SignedMessage,
  publicKey: string
): Promise<{ valid: boolean; error?: string }> {
  return verify(message, publicKey);
}

/**
 * Synchronous version of verifyMessage
 */
export function verifyMessageSync(
  message: SignedMessage,
  publicKey: string
): { valid: boolean; error?: string } {
  return verifySync(message, publicKey);
}

// =============================================================================
// Browser Storage (Development/Demo Only)
// =============================================================================

const STORAGE_PREFIX = 'imajin_keypair_';

/**
 * Store keypair in localStorage
 * 
 * ⚠️ WARNING: localStorage is NOT secure for private keys!
 * This is for development/demo only.
 * 
 * For production, consider:
 * - WebCrypto (CryptoKey with extractable: false)
 * - Hardware security keys
 * - Secure enclaves
 * - Password-encrypted storage
 */
export function storeKeypair(keypair: Keypair, name: string = 'default'): void {
  if (typeof window === 'undefined') {
    throw new Error('storeKeypair only works in browser');
  }
  
  console.warn(
    '⚠️ Storing private key in localStorage is NOT secure. ' +
    'Use only for development/demo.'
  );
  
  localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(keypair));
}

/**
 * Load keypair from localStorage
 */
export function loadKeypair(name: string = 'default'): Keypair | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  const stored = localStorage.getItem(STORAGE_PREFIX + name);
  if (!stored) return null;
  
  try {
    const keypair = JSON.parse(stored) as Keypair;
    
    // Validate the keypair
    if (!crypto.isValidPrivateKey(keypair.privateKey)) {
      console.error('Invalid private key in storage');
      return null;
    }
    if (!crypto.isValidPublicKey(keypair.publicKey)) {
      console.error('Invalid public key in storage');
      return null;
    }
    
    return keypair;
  } catch {
    return null;
  }
}

/**
 * Delete keypair from localStorage
 */
export function deleteKeypair(name: string = 'default'): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_PREFIX + name);
}

/**
 * List all stored keypair names
 */
export function listKeypairs(): string[] {
  if (typeof window === 'undefined') return [];
  
  const names: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) {
      names.push(key.slice(STORAGE_PREFIX.length));
    }
  }
  return names;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Validate that a string looks like a valid DID
 */
export function isValidDID(did: string): boolean {
  if (typeof did !== 'string') return false;
  if (!did.startsWith('did:imajin:')) return false;
  
  const suffix = did.slice('did:imajin:'.length);
  if (suffix.length !== 16) return false;
  if (!/^[0-9a-fA-F]+$/.test(suffix)) return false;
  
  return true;
}

/**
 * Extract the public key prefix from a DID
 */
export function getPublicKeyPrefixFromDID(did: string): string | null {
  if (!isValidDID(did)) return null;
  return did.slice('did:imajin:'.length);
}
