/**
 * Cryptographic primitives using @noble/ed25519
 * 
 * Ed25519: Fast, secure, audited elliptic curve signatures.
 * - 32-byte private keys
 * - 32-byte public keys  
 * - 64-byte signatures
 * - All encoded as hex strings for portability
 */

import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure ed25519 to use sha512
// Required for @noble/ed25519 v2
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert string to Uint8Array (UTF-8)
 */
export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Generate a new random private key
 */
export function generatePrivateKey(): string {
  const privateKey = ed25519.utils.randomPrivateKey();
  return bytesToHex(privateKey);
}

/**
 * Derive public key from private key
 */
export function getPublicKey(privateKeyHex: string): string {
  const privateKey = hexToBytes(privateKeyHex);
  const publicKey = ed25519.getPublicKey(privateKey);
  return bytesToHex(publicKey);
}

/**
 * Generate a new keypair
 */
export function generateKeypair(): { privateKey: string; publicKey: string } {
  const privateKey = generatePrivateKey();
  const publicKey = getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Sign a message with a private key
 * 
 * @param message - Message to sign (string or bytes)
 * @param privateKeyHex - Private key as hex string
 * @returns Signature as hex string
 */
export function signSync(message: string | Uint8Array, privateKeyHex: string): string {
  const messageBytes = typeof message === 'string' ? stringToBytes(message) : message;
  const privateKey = hexToBytes(privateKeyHex);
  const signature = ed25519.sign(messageBytes, privateKey);
  return bytesToHex(signature);
}

/**
 * Async version of sign (same result, but async for consistency)
 */
export async function sign(message: string | Uint8Array, privateKeyHex: string): Promise<string> {
  return signSync(message, privateKeyHex);
}

/**
 * Verify a signature
 * 
 * @param signature - Signature as hex string
 * @param message - Original message (string or bytes)
 * @param publicKeyHex - Public key as hex string
 * @returns true if valid, false otherwise
 */
export function verifySync(
  signature: string,
  message: string | Uint8Array,
  publicKeyHex: string
): boolean {
  try {
    const signatureBytes = hexToBytes(signature);
    const messageBytes = typeof message === 'string' ? stringToBytes(message) : message;
    const publicKey = hexToBytes(publicKeyHex);
    return ed25519.verify(signatureBytes, messageBytes, publicKey);
  } catch {
    return false;
  }
}

/**
 * Async version of verify (same result, but async for consistency)
 */
export async function verify(
  signature: string,
  message: string | Uint8Array,
  publicKeyHex: string
): Promise<boolean> {
  return verifySync(signature, message, publicKeyHex);
}

/**
 * Validate that a string is a valid hex-encoded public key
 */
export function isValidPublicKey(hex: string): boolean {
  if (typeof hex !== 'string') return false;
  if (hex.length !== 64) return false; // 32 bytes = 64 hex chars
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return true;
}

/**
 * Validate that a string is a valid hex-encoded private key
 */
export function isValidPrivateKey(hex: string): boolean {
  if (typeof hex !== 'string') return false;
  if (hex.length !== 64) return false; // 32 bytes = 64 hex chars
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return true;
}

/**
 * Validate that a string is a valid hex-encoded signature
 */
export function isValidSignature(hex: string): boolean {
  if (typeof hex !== 'string') return false;
  if (hex.length !== 128) return false; // 64 bytes = 128 hex chars
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return true;
}
