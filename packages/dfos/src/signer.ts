/**
 * Create a DFOS-compatible Signer from an imajin hex private key.
 *
 * DFOS expects: Signer = (message: Uint8Array) => Promise<Uint8Array>
 *
 * We use @metalabel/dfos-protocol's importEd25519Keypair + signPayloadEd25519
 * so the signing matches DFOS's internal conventions exactly.
 */

import { importEd25519Keypair, signPayloadEd25519 } from '@metalabel/dfos-protocol';
import type { Signer } from '@metalabel/dfos-protocol';
import { hexToBytes } from '@imajin/auth';

/**
 * Create a DFOS Signer from a hex-encoded Ed25519 private key.
 *
 * @param privateKeyHex - 64-character hex string (32-byte Ed25519 private key)
 * @returns A DFOS-compatible async signer function
 */
export function createSigner(privateKeyHex: string): Signer {
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const { privateKey } = importEd25519Keypair(privateKeyBytes);

  return async (message: Uint8Array): Promise<Uint8Array> => {
    return signPayloadEd25519(message, privateKey);
  };
}

/**
 * Derive the raw Ed25519 public key bytes from a hex private key,
 * using DFOS's own key import to ensure consistency.
 */
export function getPublicKeyBytes(privateKeyHex: string): Uint8Array {
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const { publicKey } = importEd25519Keypair(privateKeyBytes);
  return publicKey;
}
