import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { concatBytes } from '@noble/hashes/utils';
import type {
  FairManifest,
  FairManifestV1_1,
  FairSignature,
  SignedFairManifest,
  Signature,
} from './types';
import { canonicalizeForSigning } from './canonical';

// Provide synchronous sha512 so @noble/ed25519 works in all environments
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(concatBytes(...m));

// ─── Hex helpers (v1.0) ────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
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

// ─── Base64url helpers (v1.1) ──────────────────────────────────────────────

function bytesToBase64url(bytes: Uint8Array): string {
  const bin = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join('');
  const base64 = btoa(bin);
  let out = base64.split('+').join('-').split('/').join('_');
  while (out.endsWith('=')) {
    out = out.slice(0, -1);
  }
  return out;
}

function base64urlToBytes(b64: string): Uint8Array {
  const base64 = b64.split('-').join('+').split('_').join('/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

// ─── signManifest overloads ────────────────────────────────────────────────

/** Sign a v1.1 manifest with a Uint8Array private key. */
export async function signManifest(
  manifest: FairManifestV1_1,
  signer: { did: string; privateKey: Uint8Array },
): Promise<SignedFairManifest>;

/** Sign a manifest (v1.0 API) with a hex private key. */
export async function signManifest(
  manifest: FairManifest,
  privateKeyHex: string,
  signerDid: string,
): Promise<FairManifest>;

export async function signManifest(
  manifest: FairManifest,
  ...args: [string, string] | [{ did: string; privateKey: Uint8Array }]
): Promise<FairManifest | SignedFairManifest> {
  if (args.length === 2) {
    // v1.0 path
    const [privateKeyHex, signerDid] = args;
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

  // v1.1 path
  const [signer] = args;
  const stripped = { ...manifest };
  delete (stripped as Record<string, unknown>).signature;
  delete (stripped as Record<string, unknown>).platformSignature;

  const msg = new TextEncoder().encode(canonicalizeForSigning(stripped));
  const sigBytes = await ed.signAsync(msg, signer.privateKey);

  const signature: Signature = {
    signer: signer.did,
    alg: 'ed25519',
    value: bytesToBase64url(sigBytes),
    signedAt: new Date().toISOString(),
  };

  return { ...stripped, signature } as SignedFairManifest;
}

// ─── verifyManifest overloads ──────────────────────────────────────────────

/** Verify a v1.0 manifest signature. resolvePublicKey returns a hex string. */
export async function verifyManifest(
  manifest: FairManifest,
  resolvePublicKey: (did: string) => Promise<string>,
): Promise<{ valid: boolean; error?: string }>;

/** Verify a v1.1 signed manifest. resolveKey returns a Uint8Array. */
export async function verifyManifest(
  signed: SignedFairManifest,
  resolveKey: (did: string) => Promise<Uint8Array>,
): Promise<{ ok: boolean; reason?: string }>;

export async function verifyManifest(
  manifestOrSigned: FairManifest | SignedFairManifest,
  resolver: ((did: string) => Promise<string>) | ((did: string) => Promise<Uint8Array>),
): Promise<{ valid: boolean; error?: string } | { ok: boolean; reason?: string }> {
  const manifest = manifestOrSigned as FairManifest;
  const sig = manifest.signature;

  if (!sig) {
    return { valid: false, error: 'No signature present' };
  }

  // v1.1 signature has 'alg' field
  if ('alg' in sig) {
    const signed = manifestOrSigned as SignedFairManifest;
    const v1_1Sig = sig as Signature;
    if (v1_1Sig.alg !== 'ed25519') {
      return { ok: false, reason: `Unsupported algorithm: ${v1_1Sig.alg}` };
    }
    try {
      const publicKey = await (resolver as (did: string) => Promise<Uint8Array>)(v1_1Sig.signer);
      const stripped = { ...signed };
      delete (stripped as Record<string, unknown>).signature;
      delete (stripped as Record<string, unknown>).platformSignature;
      const msg = new TextEncoder().encode(canonicalizeForSigning(stripped as FairManifest));
      const valid = await ed.verifyAsync(base64urlToBytes(v1_1Sig.value), msg, publicKey);
      return valid ? { ok: true } : { ok: false, reason: 'Signature verification failed' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'Verification error' };
    }
  }

  // v1.0 path
  const v1_0Sig = sig as FairSignature;
  try {
    const publicKeyHex = await (resolver as (did: string) => Promise<string>)(v1_0Sig.publicKeyRef);
    const valid = await ed.verifyAsync(
      hexToBytes(v1_0Sig.value),
      messageBytes(manifest),
      hexToBytes(publicKeyHex),
    );
    return valid ? { valid: true } : { valid: false, error: 'Signature verification failed' };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Verification error' };
  }
}

// ─── Platform sign/verify (v1.0 API, preserved) ────────────────────────────

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
