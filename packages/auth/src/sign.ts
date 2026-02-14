/**
 * Message Signing
 * 
 * Creates signed messages that prove:
 * 1. Who sent it (from DID)
 * 2. What they are (human/agent)
 * 3. When it was sent (timestamp)
 * 4. That it wasn't tampered with (signature)
 */

import type { SignedMessage, IdentityType, Keypair } from './types';
import * as crypto from './crypto';

/**
 * Generate a new Ed25519 keypair
 * 
 * @example
 * const keypair = generateKeypair();
 * // keypair.privateKey: 64-char hex string (32 bytes)
 * // keypair.publicKey: 64-char hex string (32 bytes)
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
 * Sign a payload and create a SignedMessage
 * 
 * @example
 * const signed = await sign(
 *   { action: 'transfer', amount: 100 },
 *   keypair.privateKey,
 *   { id: 'did:imajin:abc123', type: 'human' }
 * );
 */
export async function sign<T>(
  payload: T,
  privateKey: string,
  identity: { id: string; type: IdentityType }
): Promise<SignedMessage<T>> {
  const timestamp = Date.now();
  
  // Build the message without signature
  const message: Omit<SignedMessage<T>, 'signature'> = {
    from: identity.id,
    type: identity.type,
    timestamp,
    payload,
  };
  
  // Create canonical JSON for signing (deterministic key order)
  const canonical = canonicalize(message);
  
  // Sign with Ed25519
  const signature = await crypto.sign(canonical, privateKey);
  
  return {
    ...message,
    signature,
  };
}

/**
 * Sign synchronously (for contexts where async isn't available)
 */
export function signSync<T>(
  payload: T,
  privateKey: string,
  identity: { id: string; type: IdentityType }
): SignedMessage<T> {
  const timestamp = Date.now();
  
  const message: Omit<SignedMessage<T>, 'signature'> = {
    from: identity.id,
    type: identity.type,
    timestamp,
    payload,
  };
  
  const canonical = canonicalize(message);
  const signature = crypto.signSync(canonical, privateKey);
  
  return {
    ...message,
    signature,
  };
}

/**
 * Create canonical JSON representation for signing
 * 
 * Ensures the same object always produces the same string,
 * regardless of property order.
 */
export function canonicalize(obj: unknown): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  
  if (typeof obj === 'boolean' || typeof obj === 'number') {
    return JSON.stringify(obj);
  }
  
  if (typeof obj === 'string') {
    return JSON.stringify(obj);
  }
  
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(k => 
      JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])
    );
    return '{' + pairs.join(',') + '}';
  }
  
  return String(obj);
}

/**
 * Create a challenge string for authentication
 * 
 * Used in challenge-response auth:
 * 1. Server generates challenge
 * 2. Client signs challenge
 * 3. Server verifies signature
 */
export function createChallenge(): string {
  // 32 random bytes as hex
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto !== 'undefined') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback for Node.js without webcrypto
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return crypto.bytesToHex(bytes);
}
