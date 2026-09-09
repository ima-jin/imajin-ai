/**
 * `FxSnapshot` — proof of *which* FX rate was used to convert money, so a
 * downstream record (a COGS burn read-model row, a settlement) can be
 * audited against the exact rate/source/date it relied on.
 *
 * Signing reuses `packages/auth`'s existing Ed25519 primitives verbatim
 * (`canonicalize` for deterministic key ordering, then `crypto.sign` /
 * `crypto.verify`, the same hex-encoded Ed25519 signature format every other
 * signed record in this codebase uses) rather than inventing a new scheme.
 */

import { canonicalize, crypto } from '@imajin/auth';

export interface FxSnapshot {
  readonly base: string;
  readonly quote: string;
  /** Decimal string, e.g. "1.0864" — never a float. */
  readonly rate: string;
  /** e.g. 'ecb', 'ecb:triangulated', or 'identity' for a same-currency no-op snapshot. */
  readonly source: string;
  /** The ECB reference date (YYYY-MM-DD) this rate was published for. */
  readonly asOf: string;
}

export interface SignedFxSnapshot extends FxSnapshot {
  /** Hex-encoded Ed25519 signature over the canonicalized snapshot fields. */
  readonly signature: string;
}

export async function signFxSnapshot(snapshot: FxSnapshot, privateKeyHex: string): Promise<SignedFxSnapshot> {
  const signature = await crypto.sign(canonicalize(snapshot), privateKeyHex);
  return { ...snapshot, signature };
}

export async function verifyFxSnapshot(signed: SignedFxSnapshot, publicKeyHex: string): Promise<boolean> {
  const { signature, ...snapshot } = signed;
  return crypto.verify(signature, canonicalize(snapshot), publicKeyHex);
}
