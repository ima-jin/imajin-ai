/**
 * Verification utilities
 */

import type { SignedMessage, VerificationResult } from './types';
import { canonicalize } from './sign';

/**
 * Verify a signed message
 */
export async function verify(
  message: SignedMessage,
  publicKey: string
): Promise<VerificationResult> {
  try {
    // Check timestamp isn't too old (5 min window)
    const age = Date.now() - message.timestamp;
    if (age > 5 * 60 * 1000) {
      return { valid: false, error: 'Message expired' };
    }
    
    // Check timestamp isn't in the future
    if (age < -30 * 1000) {
      return { valid: false, error: 'Timestamp in future' };
    }
    
    // Reconstruct the canonical form
    const { signature, ...rest } = message;
    const canonical = canonicalize(rest);
    
    // TODO: Verify with @noble/ed25519
    // const valid = await ed25519.verify(signature, canonical, publicKey);
    const valid = false; // placeholder
    
    if (!valid) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    return { valid: true };
  } catch (error) {
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : 'Verification failed' 
    };
  }
}

/**
 * Quick check if a message structure is valid
 * (doesn't verify signature, just structure)
 */
export function isValidMessageStructure(message: unknown): message is SignedMessage {
  if (typeof message !== 'object' || message === null) return false;
  
  const m = message as Record<string, unknown>;
  
  return (
    typeof m.from === 'string' &&
    (m.type === 'human' || m.type === 'agent') &&
    typeof m.timestamp === 'number' &&
    typeof m.signature === 'string' &&
    'payload' in m
  );
}
