/**
 * Message Verification
 * 
 * Verifies signed messages:
 * 1. Signature is valid for the message content
 * 2. Message isn't expired (optional timestamp check)
 * 3. Structure is correct
 */

import type { SignedMessage, VerificationResult } from './types';
import * as crypto from './crypto';
import { canonicalize } from './sign';
import { SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from './constants';

/** Default max age for messages (from constants) */
const DEFAULT_MAX_AGE_MS = SIGNED_MESSAGE_MAX_AGE;

/** Allow messages up to 30 seconds in the future (clock skew) */
const MAX_FUTURE_MS = FUTURE_TOLERANCE;

export interface VerifyOptions {
  /** Max age in milliseconds (default: 5 minutes, 0 = no limit) */
  maxAge?: number;
  /** Allow future timestamps (default: 30 seconds) */
  maxFuture?: number;
  /** Skip timestamp validation entirely */
  skipTimestampCheck?: boolean;
}

/**
 * Verify a signed message
 * 
 * @example
 * const result = await verify(signedMessage, publicKey);
 * if (result.valid) {
 *   console.log('Message is authentic');
 * } else {
 *   console.log('Invalid:', result.error);
 * }
 */
export async function verify(
  message: SignedMessage,
  publicKey: string,
  options: VerifyOptions = {}
): Promise<VerificationResult> {
  try {
    // Validate structure first
    if (!isValidMessageStructure(message)) {
      return { valid: false, error: 'Invalid message structure' };
    }
    
    // Validate public key format
    if (!crypto.isValidPublicKey(publicKey)) {
      return { valid: false, error: 'Invalid public key format' };
    }
    
    // Validate signature format
    if (!crypto.isValidSignature(message.signature)) {
      return { valid: false, error: 'Invalid signature format' };
    }
    
    // Check timestamp unless skipped
    if (!options.skipTimestampCheck) {
      const maxAge = options.maxAge ?? DEFAULT_MAX_AGE_MS;
      const maxFuture = options.maxFuture ?? MAX_FUTURE_MS;
      const now = Date.now();
      const age = now - message.timestamp;
      
      // Check if too old
      if (maxAge > 0 && age > maxAge) {
        return { valid: false, error: 'Message expired' };
      }
      
      // Check if too far in future
      if (age < -maxFuture) {
        return { valid: false, error: 'Timestamp in future' };
      }
    }
    
    // Reconstruct the canonical form (without signature)
    const { signature, ...rest } = message;
    const canonical = canonicalize(rest);
    
    // Verify signature
    const valid = await crypto.verify(signature, canonical, publicKey);
    
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
 * Synchronous version of verify
 */
export function verifySync(
  message: SignedMessage,
  publicKey: string,
  options: VerifyOptions = {}
): VerificationResult {
  try {
    if (!isValidMessageStructure(message)) {
      return { valid: false, error: 'Invalid message structure' };
    }
    
    if (!crypto.isValidPublicKey(publicKey)) {
      return { valid: false, error: 'Invalid public key format' };
    }
    
    if (!crypto.isValidSignature(message.signature)) {
      return { valid: false, error: 'Invalid signature format' };
    }
    
    if (!options.skipTimestampCheck) {
      const maxAge = options.maxAge ?? DEFAULT_MAX_AGE_MS;
      const maxFuture = options.maxFuture ?? MAX_FUTURE_MS;
      const now = Date.now();
      const age = now - message.timestamp;
      
      if (maxAge > 0 && age > maxAge) {
        return { valid: false, error: 'Message expired' };
      }
      
      if (age < -maxFuture) {
        return { valid: false, error: 'Timestamp in future' };
      }
    }
    
    const { signature, ...rest } = message;
    const canonical = canonicalize(rest);
    const valid = crypto.verifySync(signature, canonical, publicKey);
    
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
 * Verify a challenge response
 * 
 * Used in challenge-response authentication:
 * 1. Server sends challenge string
 * 2. Client signs: { challenge: "xxx" }
 * 3. Server verifies signature matches challenge
 */
export async function verifyChallenge(
  signedChallenge: SignedMessage<{ challenge: string }>,
  expectedChallenge: string,
  publicKey: string
): Promise<VerificationResult> {
  // First verify the signature
  const result = await verify(signedChallenge, publicKey);
  if (!result.valid) {
    return result;
  }
  
  // Then verify the challenge matches
  if (signedChallenge.payload.challenge !== expectedChallenge) {
    return { valid: false, error: 'Challenge mismatch' };
  }
  
  return { valid: true };
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

/**
 * Verify just the signature without timestamp checks
 * Useful for verifying stored/historical messages
 */
export async function verifySignatureOnly(
  message: SignedMessage,
  publicKey: string
): Promise<VerificationResult> {
  return verify(message, publicKey, { skipTimestampCheck: true });
}
