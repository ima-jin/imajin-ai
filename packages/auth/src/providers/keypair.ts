/**
 * Simple Ed25519 Keypair Provider
 * 
 * The simplest auth: you have a keypair, you sign things.
 * No server state, works offline.
 */

import type { Keypair, Identity, SignedMessage, IdentityType } from '../types';

// TODO: Import from @noble/ed25519 when ready
// import * as ed25519 from '@noble/ed25519';

/**
 * Generate a new Ed25519 keypair
 */
export async function generateKeypair(): Promise<Keypair> {
  // TODO: Implement
  // const privateKey = ed25519.utils.randomPrivateKey();
  // const publicKey = await ed25519.getPublicKeyAsync(privateKey);
  throw new Error('Not implemented - install @noble/ed25519');
}

/**
 * Create an identity from a public key
 */
export function createIdentity(
  publicKey: string,
  type: IdentityType,
  metadata?: Identity['metadata']
): Identity {
  // Generate DID from public key
  const id = `did:imajin:${publicKey.slice(0, 16)}`;
  
  return {
    id,
    type,
    publicKey,
    metadata,
    createdAt: new Date(),
  };
}

/**
 * Sign a message with a private key
 */
export async function signMessage<T>(
  payload: T,
  privateKey: string,
  identity: Pick<Identity, 'id' | 'type'>
): Promise<SignedMessage<T>> {
  const timestamp = Date.now();
  
  const unsigned = {
    from: identity.id,
    type: identity.type,
    timestamp,
    payload,
  };
  
  // Canonical JSON
  const message = JSON.stringify(unsigned, Object.keys(unsigned).sort());
  
  // TODO: Sign with ed25519
  // const signature = await ed25519.signAsync(message, privateKey);
  const signature = ''; // placeholder
  
  return {
    ...unsigned,
    signature,
  };
}

/**
 * Verify a signed message
 */
export async function verifyMessage(
  message: SignedMessage,
  publicKey: string
): Promise<boolean> {
  const { signature, ...rest } = message;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  
  // TODO: Verify with ed25519
  // return ed25519.verifyAsync(signature, canonical, publicKey);
  return false; // placeholder
}

/**
 * Store keypair securely (browser)
 * Uses localStorage with a simple wrapper
 * For production, consider using WebCrypto or a hardware key
 */
export function storeKeypair(keypair: Keypair, name: string = 'default'): void {
  if (typeof window === 'undefined') {
    throw new Error('storeKeypair only works in browser');
  }
  
  // WARNING: localStorage is not secure for private keys
  // This is for development/demo only
  localStorage.setItem(`imajin_keypair_${name}`, JSON.stringify(keypair));
}

/**
 * Load keypair from storage
 */
export function loadKeypair(name: string = 'default'): Keypair | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  const stored = localStorage.getItem(`imajin_keypair_${name}`);
  if (!stored) return null;
  
  try {
    return JSON.parse(stored) as Keypair;
  } catch {
    return null;
  }
}
