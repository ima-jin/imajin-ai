import type { FairManifest } from './types';

/**
 * Deterministic JSON canonicalization: sorted keys, no whitespace.
 * Used to produce the byte string that is signed/verified.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((key) => JSON.stringify(key) + ':' + canonicalize(obj[key]));
  return '{' + parts.join(',') + '}';
}

/**
 * Return the canonical string for signing.
 * Strips both signature fields before canonicalizing so that signing and
 * verification produce identical byte strings regardless of which fields
 * are present.
 */
export function canonicalizeForSigning(manifest: FairManifest): string {
  const clone = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete clone.signature;
  delete clone.platformSignature;
  return canonicalize(clone);
}
