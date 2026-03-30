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
 * PKCS#8 Ed25519 DER prefix (16 bytes / 32 hex chars).
 * Full PKCS#8 DER = this prefix + 32-byte raw seed = 48 bytes (96 hex chars).
 */
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

/**
 * Extract the raw 32-byte Ed25519 seed from a private key hex string.
 * Accepts both raw 32-byte hex (64 chars) and PKCS#8 DER hex (96 chars).
 * All private key operations should go through this to normalize key format.
 */
export function extractPrivateKeySeed(privateKeyHex: string): string {
  const cleaned = privateKeyHex.toLowerCase().trim();
  if (cleaned.length === 64) {
    // Already raw 32-byte seed
    return cleaned;
  }
  if (cleaned.length === 96 && cleaned.startsWith(PKCS8_ED25519_PREFIX)) {
    // PKCS#8 DER — extract last 32 bytes (64 hex chars)
    return cleaned.slice(32);
  }
  throw new Error(
    `Invalid Ed25519 private key: expected 64 hex chars (raw) or 96 hex chars (PKCS#8), got ${cleaned.length}`
  );
}

/**
 * Generate a new random private key
 */
export function generatePrivateKey(): string {
  const privateKey = ed25519.utils.randomPrivateKey();
  return bytesToHex(privateKey);
}

/**
 * Derive public key from private key.
 * Accepts raw 32-byte hex or PKCS#8 DER hex.
 */
export function getPublicKey(privateKeyHex: string): string {
  const seed = extractPrivateKeySeed(privateKeyHex);
  const privateKey = hexToBytes(seed);
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
  const seed = extractPrivateKeySeed(privateKeyHex);
  const privateKey = hexToBytes(seed);
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

// ─── Base58btc encoding (Bitcoin alphabet, no external dep) ──────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const b of bytes) {
    num = num * BigInt(256) + BigInt(b);
  }
  let result = '';
  while (num > BigInt(0)) {
    result = BASE58_ALPHABET[Number(num % BigInt(58))] + result;
    num = num / BigInt(58);
  }
  // Leading zero bytes → leading '1's
  for (const b of bytes) {
    if (b !== 0) break;
    result = '1' + result;
  }
  return result;
}

function base58Decode(str: string): Uint8Array {
  let num = BigInt(0);
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base58 character: ${ch}`);
    num = num * BigInt(58) + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > BigInt(0)) {
    bytes.unshift(Number(num % BigInt(256)));
    num = num / BigInt(256);
  }
  // Leading '1's → leading zero bytes
  for (const ch of str) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

// ─── Multikey encoding ────────────────────────────────────────────────────────

// Multikey header: 0xed = Ed25519, 0x01 = public key
const MULTIKEY_ED25519_HEADER = new Uint8Array([0xed, 0x01]);

/**
 * Encode an Ed25519 public key (raw 32 bytes) as a W3C Multikey multibase string.
 *
 * Format: 'z' + base58btc([0xed, 0x01] + publicKeyBytes)
 * Result starts with "z6Mk..."
 */
export function bytesToMultibase(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }
  const prefixed = new Uint8Array(MULTIKEY_ED25519_HEADER.length + publicKey.length);
  prefixed.set(MULTIKEY_ED25519_HEADER);
  prefixed.set(publicKey, MULTIKEY_ED25519_HEADER.length);
  return 'z' + base58Encode(prefixed);
}

/**
 * Decode a W3C Multikey multibase string back to raw Ed25519 public key bytes.
 */
export function multibaseToPubkey(multibase: string): Uint8Array {
  if (!multibase.startsWith('z')) {
    throw new Error('Multibase must start with z (base58btc)');
  }
  const decoded = base58Decode(multibase.slice(1));
  if (decoded.length !== 34) {
    throw new Error(`Expected 34 bytes (2 header + 32 key), got ${decoded.length}`);
  }
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error('Invalid Multikey header (expected 0xed01 for Ed25519)');
  }
  return decoded.slice(2);
}

/**
 * Convert a hex-encoded Ed25519 public key to a W3C Multikey multibase string.
 */
export function hexToMultibase(publicKeyHex: string): string {
  return bytesToMultibase(hexToBytes(publicKeyHex));
}

/**
 * Convert a W3C Multikey multibase string to a hex-encoded Ed25519 public key.
 */
export function multibaseToHex(multibase: string): string {
  return bytesToHex(multibaseToPubkey(multibase));
}
