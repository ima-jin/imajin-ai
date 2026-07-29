/**
 * Nostr (secp256k1 Schnorr / BIP-340) cryptographic utilities
 *
 * Used for the `imajin/nostr-key-binding` dual-signature proof-of-control
 * handshake (#1411). Both the DID key and the Nostr key sign the same
 * attestation canonical payload:
 *
 *   digest = SHA-256( UTF-8( canonicalize({subject_did, type, ...}) ) )
 *
 * The DID signs the raw canonical UTF-8 bytes with Ed25519.
 * The Nostr key signs the 32-byte SHA-256 digest with secp256k1 Schnorr
 * (required by BIP-340 / NIP-01 convention).
 *
 * Both signatures are derived from the same canonical form; `nostr_sig` is
 * stored as a separate column on the attestation row (never inside `payload`)
 * so it is never part of what is signed — no circular dependency.
 */

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from './crypto';

/**
 * Compute the 32-byte attestation digest that both keys sign.
 * SHA-256( UTF-8(canonicalPayload) )
 */
export function nostrAttestationDigest(canonicalPayload: string): Uint8Array {
  return sha256(new TextEncoder().encode(canonicalPayload));
}

/**
 * Verify a secp256k1 Schnorr (BIP-340) signature over the attestation digest.
 *
 * @param nostrSigHex    64-byte Schnorr signature as hex (128 hex chars)
 * @param canonicalPayload  The same canonical JSON string used for the DID signature
 * @param nostrPubkeyHex 32-byte x-only secp256k1 public key as hex (64 hex chars)
 * @returns true if the signature is valid, false for any mismatch or error
 */
export function verifyNostrSig(
  nostrSigHex: string,
  canonicalPayload: string,
  nostrPubkeyHex: string,
): boolean {
  try {
    const digest = nostrAttestationDigest(canonicalPayload);
    return schnorr.verify(nostrSigHex, digest, nostrPubkeyHex);
  } catch {
    return false;
  }
}

/**
 * Sign the attestation canonical payload with a Nostr (secp256k1) private key.
 * Returns the 64-byte Schnorr signature as hex (128 chars).
 *
 * Intended for clients and tests. Private keys should never be handled
 * server-side; this is provided here for completeness and SDK use.
 */
export function signNostrAttestation(
  canonicalPayload: string,
  nostrPrivkeyHex: string,
): string {
  const digest = nostrAttestationDigest(canonicalPayload);
  return bytesToHex(schnorr.sign(digest, nostrPrivkeyHex));
}

/**
 * Derive the 32-byte x-only secp256k1 public key (BIP-340) from a private key.
 * Returns the public key as hex (64 chars).
 */
export function getNostrPublicKey(nostrPrivkeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(nostrPrivkeyHex));
}
