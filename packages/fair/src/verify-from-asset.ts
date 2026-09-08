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

/** Parse the href from a `Link: rel="fair"` header value. Returns null when absent. */
function parseFairLinkHref(linkHeader: string): string | null {
  for (const segment of linkHeader.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed.includes('rel="fair"')) continue;
    const lt = trimmed.indexOf('<');
    const gt = trimmed.indexOf('>', lt + 1);
    if (lt >= 0 && gt > lt) return trimmed.slice(lt + 1, gt).trim();
  }
  return null;
}

/** Verify the DFOS anchor header against the manifest digest. */
async function verifyDfosAnchor(
  manifest: SignedFairManifest,
  dfosHeader: string,
  fetchDfosEvent: VerifyManifestFromAssetOptions['fetchDfosEvent'],
): Promise<{ ok: true; anchorTimestamp: string } | { ok: false; reason: string }> {
  const prefix = 'dfos:event:';
  if (!dfosHeader.startsWith(prefix)) {
    return { ok: false, reason: `Invalid X-Fair-Dfos header format: ${dfosHeader}` };
  }
  const event = await fetchDfosEvent(dfosHeader.slice(prefix.length));
  if (!event) return { ok: false, reason: `DFOS event not found: ${dfosHeader.slice(prefix.length)}` };
  const payload = event.payload as { manifestDigest?: string };
  const manifestDigest = `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalize(manifest))))}`;
  if (payload.manifestDigest !== manifestDigest) {
    return { ok: false, reason: 'DFOS event manifestDigest does not match recomputed digest' };
  }
  return { ok: true, anchorTimestamp: event.anchoredAt };
}

type FetchStep = { response: FetchResponse } | { error: string };

/** Fetch a URL via the injected fetcher, normalizing non-ok status and thrown errors into a single error shape. */
async function fetchStep(
  url: string,
  fetchAsset: VerifyManifestFromAssetOptions['fetchAsset'],
  notOkMessage: string,
  catchLabel: string,
): Promise<FetchStep> {
  try {
    const response = await fetchAsset(url);
    if (!response.ok) return { error: notOkMessage };
    return { response };
  } catch (err) {
    return { error: `Failed to fetch ${catchLabel}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Parse and validate the manifest JSON body. */
async function parseManifestJson(
  manifestResponse: FetchResponse,
): Promise<{ manifest: SignedFairManifest } | { error: string }> {
  try {
    return { manifest: (await manifestResponse.json()) as SignedFairManifest };
  } catch {
    return { error: 'Manifest response is not valid JSON' };
  }
}

function computeManifestDigest(manifest: SignedFairManifest): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalize(manifest))))}`;
}

/** Verify the manifest's embedded signature is present and valid. */
async function verifySignatureStep(
  manifest: SignedFairManifest,
  resolveOwnerKey: VerifyManifestFromAssetOptions['resolveOwnerKey'],
): Promise<{ signedAt?: string } | { error: string }> {
  const sig = manifest.signature;
  if (!sig || typeof sig !== 'object' || !('alg' in sig)) {
    return { error: 'Manifest is not a v1.1 signed manifest' };
  }
  const verifyResult = await verifyManifest(manifest, resolveOwnerKey);
  if (('ok' in verifyResult && !verifyResult.ok) || ('valid' in verifyResult && !verifyResult.valid)) {
    return { error: (verifyResult as { reason?: string }).reason || 'Signature verification failed' };
  }
  return { signedAt: 'signedAt' in sig ? (sig as { signedAt?: string }).signedAt : undefined };
}

/** Check X-Fair-Digest against the recomputed manifest digest, when present. */
function verifyDigestHeader(assetResponse: FetchResponse, manifest: SignedFairManifest): { error: string } | null {
  const digestHeader = assetResponse.headers.get('x-fair-digest') || '';
  if (!digestHeader) return null;
  const expected = computeManifestDigest(manifest);
  if (digestHeader !== expected) {
    return { error: `Digest mismatch: expected ${expected}, got ${digestHeader}` };
  }
  return null;
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
  const assetResult = await fetchStep(assetUrl, opts.fetchAsset, 'Asset fetch failed with non-ok status', 'asset');
  if ('error' in assetResult) return { valid: false, reason: assetResult.error };
  const { response: assetResponse } = assetResult;

  const fairHref = parseFairLinkHref(assetResponse.headers.get('link') || '');
  if (!fairHref) {
    return { valid: false, reason: 'Missing Link: rel="fair" header on asset response' };
  }

  // 2. Fetch manifest
  const manifestResult = await fetchStep(
    new URL(fairHref, assetUrl).toString(),
    opts.fetchAsset,
    'Manifest fetch failed with non-ok status',
    'manifest',
  );
  if ('error' in manifestResult) return { valid: false, reason: manifestResult.error };

  const parsed = await parseManifestJson(manifestResult.response);
  if ('error' in parsed) return { valid: false, reason: parsed.error };
  const { manifest } = parsed;

  // 3. Verify signature
  const sigResult = await verifySignatureStep(manifest, opts.resolveOwnerKey);
  if ('error' in sigResult) return { valid: false, reason: sigResult.error };
  const { signedAt } = sigResult;

  // 4. Check X-Fair-Digest
  const digestError = verifyDigestHeader(assetResponse, manifest);
  if (digestError) return { valid: false, signedAt, reason: digestError.error };

  // 5. Verify DFOS anchor if present
  const dfosHeader = assetResponse.headers.get('x-fair-dfos') || '';
  let anchorTimestamp: string | undefined;
  if (dfosHeader) {
    const dfosResult = await verifyDfosAnchor(manifest, dfosHeader, opts.fetchDfosEvent);
    if (!dfosResult.ok) return { valid: false, signedAt, reason: dfosResult.reason };
    anchorTimestamp = dfosResult.anchorTimestamp;
  }

  return { valid: true, signedAt, anchorTimestamp, owner: manifest.owner };
}
