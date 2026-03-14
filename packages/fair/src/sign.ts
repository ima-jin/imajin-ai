import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import type { FairManifest, FairSignature } from './types';
import { canonicalizeForSigning } from './canonical';

// Provide synchronous sha512 so @noble/ed25519 works in all environments
ed.etc.sha512Sync = (...m) => sha512(...m);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function messageBytes(manifest: FairManifest): Uint8Array {
  return new TextEncoder().encode(canonicalizeForSigning(manifest));
}

/** Sign a manifest as the creator/signer identified by signerDid. */
export async function signManifest(
  manifest: FairManifest,
  privateKeyHex: string,
  signerDid: string,
): Promise<FairManifest> {
  const privateKey = hexToBytes(privateKeyHex);
  const msg = messageBytes(manifest);
  const sigBytes = await ed.signAsync(msg, privateKey);
  const signature: FairSignature = {
    algorithm: 'ed25519',
    value: bytesToHex(sigBytes),
    publicKeyRef: signerDid,
  };
  return { ...manifest, signature };
}

/** Verify the creator signature on a manifest. resolvePublicKey maps a DID to a hex public key. */
export async function verifyManifest(
  manifest: FairManifest,
  resolvePublicKey: (did: string) => Promise<string>,
): Promise<{ valid: boolean; error?: string }> {
  if (!manifest.signature) {
    return { valid: false, error: 'No signature present' };
  }
  try {
    const { value, publicKeyRef } = manifest.signature;
    const publicKeyHex = await resolvePublicKey(publicKeyRef);
    const valid = await ed.verifyAsync(
      hexToBytes(value),
      messageBytes(manifest),
      hexToBytes(publicKeyHex),
    );
    return valid ? { valid: true } : { valid: false, error: 'Signature verification failed' };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Verification error' };
  }
}

/** Endorse a manifest with a platform signature. */
export async function platformSign(
  manifest: FairManifest,
  platformPrivateKeyHex: string,
  platformDid: string,
): Promise<FairManifest> {
  const privateKey = hexToBytes(platformPrivateKeyHex);
  const msg = messageBytes(manifest);
  const sigBytes = await ed.signAsync(msg, privateKey);
  const platformSignature: FairSignature = {
    algorithm: 'ed25519',
    value: bytesToHex(sigBytes),
    publicKeyRef: platformDid,
  };
  return { ...manifest, platformSignature };
}

/** Verify the platform endorsement signature on a manifest. */
export async function verifyPlatformSignature(
  manifest: FairManifest,
  resolvePublicKey: (did: string) => Promise<string>,
): Promise<{ valid: boolean; error?: string }> {
  if (!manifest.platformSignature) {
    return { valid: false, error: 'No platform signature present' };
  }
  try {
    const { value, publicKeyRef } = manifest.platformSignature;
    const publicKeyHex = await resolvePublicKey(publicKeyRef);
    const valid = await ed.verifyAsync(
      hexToBytes(value),
      messageBytes(manifest),
      hexToBytes(publicKeyHex),
    );
    return valid
      ? { valid: true }
      : { valid: false, error: 'Platform signature verification failed' };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Verification error' };
  }
}
