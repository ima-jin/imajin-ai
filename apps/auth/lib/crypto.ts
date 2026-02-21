import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import bs58 from 'bs58';

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
    console.error('Signature verification error:', error);
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
