import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

// Configure ed25519 to use sha512
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Derive a DID from a public key
 * Format: did:imajin:{base58(publicKey)}
 */
export function didFromPublicKey(publicKeyHex: string): string {
  const publicKeyBytes = hexToBytes(publicKeyHex);
  const encoded = bs58.encode(publicKeyBytes);
  return `did:imajin:${encoded}`;
}

/**
 * Extract public key from DID
 */
export function publicKeyFromDid(did: string): string | null {
  const match = did.match(/^did:imajin:(.+)$/);
  if (!match) return null;
  
  try {
    const publicKeyBytes = bs58.decode(match[1]);
    return bytesToHex(publicKeyBytes);
  } catch {
    return null;
  }
}

/**
 * Verify a signature
 */
export async function verifySignature(
  message: string,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = hexToBytes(signatureHex);
    const publicKeyBytes = hexToBytes(publicKeyHex);
    
    return await ed.verifyAsync(signatureBytes, messageBytes, publicKeyBytes);
  } catch (error) {
    log.error({ err: String(error) }, 'signature verification error');
    return false;
  }
}

/**
 * Generate a random challenge
 */
export function generateChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Encrypt a private key using AES-256-GCM with PBKDF2 key derivation.
 * Uses GROUP_KEY_ENCRYPTION_SECRET env var as the master secret.
 */
export async function encryptPrivateKey(privateKeyHex: string): Promise<{ encryptedKey: string; salt: string }> {
  const secret = process.env.GROUP_KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error('GROUP_KEY_ENCRYPTION_SECRET not set');

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Buffer.from(saltBytes).toString('base64');

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const derivedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(privateKeyHex);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, derivedKey, plaintext);

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return { encryptedKey: Buffer.from(combined).toString('base64'), salt };
}

// Hex utilities
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
