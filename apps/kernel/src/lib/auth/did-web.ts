/**
 * did:web resolution and verification (#1900) — the trust anchor for a
 * knock's optional `external_did` claim. Domain control is the trust
 * anchor, same root as TLS: an `external_did` of method `did:web` is
 * VERIFIED only when the knock's own Ed25519 public key appears among the
 * resolved DID document's verification methods.
 *
 * Fail-closed and non-fatal by construction: any resolution problem
 * (network error, timeout, missing/malformed did.json) yields
 * `resolution_failed`, never `verified`, and never blocks the knock
 * itself. Non-did:web methods are out of scope for v1 (#1900 scope notes)
 * and are always `declared_unverified` — declared but never checked.
 *
 * v1 only checks whether the knock's own public key is directly listed in
 * the resolved document (the primary path from #1900's proposal). The
 * proposal's alternate path — "or the knock carries a signature from a
 * listed key" — has no carrier field on a knock today and is left for a
 * follow-up; a knock's own key not being listed resolves to
 * `declared_unverified`, never `resolution_failed`.
 */
import bs58 from 'bs58';
import { multibaseToHex } from '@imajin/auth';
import type { ExternalDidVerificationState } from '@imajin/auth';
import { DID_WEB_RESOLUTION_TIMEOUT_MS } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface ExternalDidVerificationResult {
  state: ExternalDidVerificationState;
  verifiedAt: Date;
}

/**
 * Convert a did:web identifier into the HTTPS URL of its DID document, per
 * the did:web spec (https://w3c-ccg.github.io/did-method-web/):
 *   - `did:web:example.com` -> `https://example.com/.well-known/did.json`
 *   - `did:web:example.com:u:alice` -> `https://example.com/u/alice/did.json`
 *     (path-based form — no `.well-known` segment once a path is present)
 *   - A percent-encoded colon in the domain segment (`%3A`) denotes a port,
 *     e.g. `did:web:example.com%3A3000` -> `https://example.com:3000/...`
 * Returns null when `did` is not a well-formed did:web identifier.
 */
export function didWebToUrl(did: string): string | null {
  const match = /^did:web:(.+)$/.exec(did);
  if (!match) return null;

  const segments = match[1].split(':').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  let domainAndPort: string;
  try {
    domainAndPort = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  if (!domainAndPort) return null;

  const pathSegments = segments.slice(1);
  if (pathSegments.length === 0) {
    return `https://${domainAndPort}/.well-known/did.json`;
  }

  try {
    const path = pathSegments.map((segment) => decodeURIComponent(segment)).join('/');
    return `https://${domainAndPort}/${path}/did.json`;
  } catch {
    return null;
  }
}

interface RawVerificationMethod {
  publicKeyMultibase?: unknown;
  publicKeyBase58?: unknown;
  publicKeyHex?: unknown;
  publicKeyJwk?: unknown;
}

function fromMultibase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return multibaseToHex(value).toLowerCase();
  } catch {
    return null; // Not a Multikey (0xed01 Ed25519) multibase string.
  }
}

function fromBase58(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(bs58.decode(value)).toString('hex').toLowerCase();
  } catch {
    return null; // Invalid base58.
  }
}

function fromHex(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) return null;
  return value.toLowerCase();
}

function fromOkpJwk(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const { kty, crv, x } = value as { kty?: unknown; crv?: unknown; x?: unknown };
  if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string') return null;
  try {
    return Buffer.from(x, 'base64url').toString('hex').toLowerCase();
  } catch {
    return null; // Malformed base64url.
  }
}

/**
 * Best-effort decode of a single W3C verification-method entry to a
 * lowercase hex-encoded raw public key, trying every encoding the did:web
 * spec's ecosystem commonly uses. Returns null if none apply/parse.
 */
function verificationMethodToHex(method: RawVerificationMethod): string | null {
  return (
    fromMultibase(method.publicKeyMultibase) ??
    fromBase58(method.publicKeyBase58) ??
    fromHex(method.publicKeyHex) ??
    fromOkpJwk(method.publicKeyJwk)
  );
}

/** Whether a resolved DID document lists `publicKeyHex` among its verification methods. */
export function documentContainsKey(document: unknown, publicKeyHex: string): boolean {
  if (!document || typeof document !== 'object') return false;
  const methods = (document as { verificationMethod?: unknown }).verificationMethod;
  if (!Array.isArray(methods)) return false;

  const target = publicKeyHex.toLowerCase();
  return methods.some((method) => {
    if (!method || typeof method !== 'object') return false;
    return verificationMethodToHex(method as RawVerificationMethod) === target;
  });
}

async function fetchDidDocument(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DID_WEB_RESOLUTION_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/did+json, application/json' },
    });
    if (!response.ok) {
      throw new Error(`did:web resolution returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve and verify a knock's `external_did` claim against its DID
 * document. Only method `did:web` is checked in v1 — every other method
 * is `declared_unverified` by construction (#1900 scope notes).
 */
export async function resolveExternalDidVerification(
  externalDid: string,
  publicKeyHex: string,
): Promise<ExternalDidVerificationResult> {
  const verifiedAt = new Date();

  if (!externalDid.startsWith('did:web:')) {
    return { state: 'declared_unverified', verifiedAt };
  }

  const url = didWebToUrl(externalDid);
  if (!url) {
    return { state: 'resolution_failed', verifiedAt };
  }

  let document: unknown;
  try {
    document = await fetchDidDocument(url);
  } catch (error) {
    log.warn({ err: String(error), externalDid }, '[did-web] resolution failed');
    return { state: 'resolution_failed', verifiedAt };
  }

  const state: ExternalDidVerificationState = documentContainsKey(document, publicKeyHex)
    ? 'verified'
    : 'declared_unverified';
  return { state, verifiedAt };
}
