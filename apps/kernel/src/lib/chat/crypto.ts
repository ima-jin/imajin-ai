/**
 * E2EE utilities using @noble libraries
 * 
 * Simplified implementation - upgrade to full Signal Protocol (Sender Keys) later
 */

import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

/**
 * Generate a new X25519 key pair
 */
export function generateKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Derive shared secret using X25519
 */
export function deriveSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const sharedPoint = x25519.getSharedSecret(privateKey, publicKey);
  // Use HKDF to derive a proper key
  return hkdf(sha256, sharedPoint, undefined, 'imajin-chat-v1', 32);
}

/**
 * Encrypt a message
 */
export function encryptMessage(
  plaintext: string,
  sharedSecret: Uint8Array
): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(24); // XChaCha20 uses 24-byte nonce
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);
  
  const cipher = xchacha20poly1305(sharedSecret, nonce);
  const ciphertext = cipher.encrypt(plaintextBytes);
  
  return {
    ciphertext: Buffer.from(ciphertext).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  };
}

/**
 * Decrypt a message
 */
export function decryptMessage(
  ciphertext: string,
  nonce: string,
  sharedSecret: Uint8Array
): string {
  const ciphertextBytes = Buffer.from(ciphertext, 'base64');
  const nonceBytes = Buffer.from(nonce, 'base64');
  
  const cipher = xchacha20poly1305(sharedSecret, nonceBytes);
  const plaintextBytes = cipher.decrypt(ciphertextBytes);
  
  const decoder = new TextDecoder();
  return decoder.decode(plaintextBytes);
}

/**
 * Convert key to hex string for storage
 */
export function keyToHex(key: Uint8Array): string {
  return Buffer.from(key).toString('hex');
}

/**
 * Convert hex string back to key
 */
export function hexToKey(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Group key management (simplified)
 * For groups, we use a shared group key that's re-encrypted to each member
 */
export function generateGroupKey(): Uint8Array {
  return randomBytes(32);
}

/**
 * Encrypt group key for a specific member
 */
export function encryptGroupKey(
  groupKey: Uint8Array,
  memberPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array
): { encryptedKey: string; nonce: string } {
  const sharedSecret = deriveSharedSecret(senderPrivateKey, memberPublicKey);
  const nonce = randomBytes(24);
  
  const cipher = xchacha20poly1305(sharedSecret, nonce);
  const encrypted = cipher.encrypt(groupKey);
  
  return {
    encryptedKey: Buffer.from(encrypted).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  };
}
