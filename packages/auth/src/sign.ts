/**
 * Signing utilities
 */

import type { SignedMessage, IdentityType, Keypair } from './types';

// Will use @noble/ed25519 when implemented
// For now, placeholder exports

/**
 * Generate a new Ed25519 keypair
 */
export async function generateKeypair(): Promise<Keypair> {
  // TODO: Implement with @noble/ed25519
  throw new Error('Not implemented yet');
}

/**
 * Sign a payload and create a SignedMessage
 */
export async function sign<T>(
  payload: T,
  privateKey: string,
  identity: { id: string; type: IdentityType }
): Promise<SignedMessage<T>> {
  const timestamp = Date.now();
  
  const message: Omit<SignedMessage<T>, 'signature'> = {
    from: identity.id,
    type: identity.type,
    timestamp,
    payload,
  };
  
  // Canonical JSON for signing
  const canonical = JSON.stringify(message, Object.keys(message).sort());
  
  // TODO: Sign with @noble/ed25519
  const signature = ''; // placeholder
  
  return {
    ...message,
    signature,
  };
}

/**
 * Create canonical JSON representation for signing
 */
export function canonicalize(obj: unknown): string {
  if (typeof obj !== 'object' || obj === null) {
    return JSON.stringify(obj);
  }
  
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => 
    JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])
  );
  
  return '{' + pairs.join(',') + '}';
}
