/**
 * Verify a .fair manifest from an asset's sidecar delivery headers.
 *
 * Pure injection-based: no global fetch is used. The caller provides
 * fetchers for the asset, the manifest, and the DFOS event.
 */

import { verifyManifest } from './sign';
import { canonicalize } from './canonical';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { SignedFairManifest } from './types';

/** Minimal fetch response interface for injection */
export interface FetchResponse {
  ok: boolean;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Result of manifest verification */
export interface VerificationResult {
  valid: boolean;
  signedAt?: string;
  anchorTimestamp?: string;
  owner?: string;
  reason?: string;
}

/** Options for verifyManifestFromAsset */
export interface VerifyManifestFromAssetOptions {
  /** Resolve a DID to its Ed25519 public key bytes */
  resolveOwnerKey: (did: string) => Promise<Uint8Array>;
  /** Fetch a DFOS event by ID (return null if not found) */
  fetchDfosEvent: (eventId: string) => Promise<{
    topic: string;
    payload: unknown;
    anchoredAt: string;
    signature: string;
  } | null>;
  /** Fetch a URL and return a minimal response interface */
  fetchAsset: (url: string) => Promise<FetchResponse>;
}

/**
 * Verify a .fair manifest from an asset URL.
 *
 * 1. Fetch the asset, read Link: rel="fair" header
 * 2. Fetch the manifest from the Link target
 * 3. Verify the manifest signature
 * 4. Check X-Fair-Digest matches the recomputed digest
 * 5. If X-Fair-Dfos header is present, fetch and verify the DFOS anchor
 */
export async function verifyManifestFromAsset(
  assetUrl: string,
  opts: VerifyManifestFromAssetOptions,
): Promise<VerificationResult> {
  // 1. Fetch asset and read Link header
  let assetResponse: FetchResponse;
  try {
    assetResponse = await opts.fetchAsset(assetUrl);
  } catch (err) {
    return { valid: false, reason: `Failed to fetch asset: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!assetResponse.ok) {
    return { valid: false, reason: `Asset fetch failed with status: ${assetResponse.ok === false ? 'non-ok' : 'unknown'}` };
  }

  const linkHeader = assetResponse.headers.get('link') || '';
  let fairHref: string | null = null;
  for (const segment of linkHeader.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed.includes('rel="fair"')) continue;
    const lt = trimmed.indexOf('<');
    const gt = trimmed.indexOf('>', lt + 1);
    if (lt >= 0 && gt > lt) {
      fairHref = trimmed.slice(lt + 1, gt).trim();
      break;
    }
  }
  if (!fairHref) {
    return { valid: false, reason: 'Missing Link: rel="fair" header on asset response' };
  }
  const manifestUrl = new URL(fairHref, assetUrl).toString();

  // 2. Fetch manifest
  let manifestResponse: FetchResponse;
  try {
    manifestResponse = await opts.fetchAsset(manifestUrl);
  } catch (err) {
    return { valid: false, reason: `Failed to fetch manifest: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!manifestResponse.ok) {
    return { valid: false, reason: 'Manifest fetch failed with non-ok status' };
  }

  let manifest: SignedFairManifest;
  try {
    manifest = (await manifestResponse.json()) as SignedFairManifest;
  } catch {
    return { valid: false, reason: 'Manifest response is not valid JSON' };
  }

  // 3. Verify signature
  const sig = manifest.signature;
  if (!sig || typeof sig !== 'object' || !('alg' in sig)) {
    return { valid: false, reason: 'Manifest is not a v1.1 signed manifest' };
  }

  const verifyResult = await verifyManifest(manifest, opts.resolveOwnerKey);
  if ('ok' in verifyResult && !verifyResult.ok) {
    return { valid: false, reason: verifyResult.reason || 'Signature verification failed' };
  }
  if ('valid' in verifyResult && !verifyResult.valid) {
    return { valid: false, reason: verifyResult.error || 'Signature verification failed' };
  }

  const signedAt = sig && 'signedAt' in sig ? (sig as { signedAt?: string }).signedAt : undefined;

  // 4. Check X-Fair-Digest
  const digestHeader = assetResponse.headers.get('x-fair-digest') || '';
  if (digestHeader) {
    const expectedDigest = bytesToHex(sha256(new TextEncoder().encode(canonicalize(manifest))));
    const expected = `sha256:${expectedDigest}`;
    if (digestHeader !== expected) {
      return { valid: false, signedAt, reason: `Digest mismatch: expected ${expected}, got ${digestHeader}` };
    }
  }

  // 5. Verify DFOS anchor if present
  const dfosHeader = assetResponse.headers.get('x-fair-dfos') || '';
  let anchorTimestamp: string | undefined;
  if (dfosHeader) {
    const prefix = 'dfos:event:';
    if (!dfosHeader.startsWith(prefix)) {
      return { valid: false, signedAt, reason: `Invalid X-Fair-Dfos header format: ${dfosHeader}` };
    }
    const eventId = dfosHeader.slice(prefix.length);
    const event = await opts.fetchDfosEvent(eventId);
    if (!event) {
      return { valid: false, signedAt, reason: `DFOS event not found: ${eventId}` };
    }

    // Verify the DFOS payload matches the manifest
    const payload = event.payload as {
      assetId?: string;
      ownerDid?: string;
      manifestDigest?: string;
      manifestUrl?: string;
      fairVersion?: string;
      signedAt?: string;
    };

    const manifestDigest = bytesToHex(sha256(new TextEncoder().encode(canonicalize(manifest))));
    if (payload.manifestDigest !== `sha256:${manifestDigest}`) {
      return { valid: false, signedAt, reason: 'DFOS event manifestDigest does not match recomputed digest' };
    }

    anchorTimestamp = event.anchoredAt;
  }

  return {
    valid: true,
    signedAt,
    anchorTimestamp,
    owner: manifest.creator,
  };
}
