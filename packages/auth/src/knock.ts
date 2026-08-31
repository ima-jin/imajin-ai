/**
 * External-agent knock model (#1883) — the "knock, not registration"
 * onboarding path settled at the #1881 Day-1 review (2026-08-30).
 *
 * A knock declares `{ publicKey, declared_target, self_description,
 * requested_capabilities[] }`. It carries zero authority:
 * `requested_capabilities` are an advisory preview shown to the target at
 * accept-time and are never auto-granted — #1882 delegation grants are the
 * only path to authority, issued separately, strictly user-push, after
 * acceptance. No identity is minted from a knock alone.
 *
 * This module is deliberately dependency-free and client-safe (mirrors
 * grant-scopes.ts / delegation-grant.ts) so external agents and the kernel
 * can share the same shape/validation vocabulary. The DB-touching lifecycle
 * (submit / list / accept / decline) lives in
 * apps/kernel/src/lib/auth/knock.ts.
 */
import { isDid } from './delegation-grant';
import { GRANT_SCOPE_GRAMMAR } from './grant-scopes';

export const KNOCK_SELF_DESCRIPTION_MAX_LENGTH = 1000;
export const KNOCK_MAX_REQUESTED_CAPABILITIES = 20;

/** 32-byte Ed25519 public key, hex-encoded (64 hex chars) — held in escrow, never trusted as an identity until accept. */
export function isKnockPublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Advisory only. Grammar-checked (`domain:verb`, same shape as #1882's
 * closed registry) so the accept-time preview UI has a sane, comparable
 * shape, but deliberately NOT checked against `GRANT_SCOPE_REGISTRY` — a
 * knock may declare intent to request capabilities that don't (yet) exist
 * in the registry, and this array is never used to authorize anything.
 */
export function isKnockRequestedCapabilities(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length > KNOCK_MAX_REQUESTED_CAPABILITIES) return false;
  return value.every((entry) => typeof entry === 'string' && GRANT_SCOPE_GRAMMAR.test(entry));
}

export function isKnockSelfDescription(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= KNOCK_SELF_DESCRIPTION_MAX_LENGTH;
}

/**
 * Optional bring-your-own DID the agent claims to also be identified by
 * (e.g. `did:web:boardy.ai`). Never used as the auth basis — v1 always mints
 * a did:imajin identity on accept regardless; this is recorded as an
 * attestation only ("this imajin identity is operated by did:web:boardy.ai").
 */
export function isKnockExternalDid(value: unknown): value is string {
  return isDid(value);
}

/**
 * Fail-closed like #1882 grants: status only ever moves pending -> accepted
 * | declined. There is no stored 'expired' status — expiry is a plain
 * `expiresAt` timestamp compared at list/accept/decline time, never swept
 * into a cached status.
 */
export const KNOCK_STATUSES = ['pending', 'accepted', 'declined'] as const;
export type KnockStatus = typeof KNOCK_STATUSES[number];
