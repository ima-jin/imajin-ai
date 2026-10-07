/**
 * Node signing-key rotation primitives (#2081) — the `key.rotated` attestation.
 *
 * `AUTH_PRIVATE_KEY` is one process secret that plays several roles (session
 * JWTs, CorpusAccessClaims, node-issued attestations, vault sealing, ...; the
 * full inventory lives in docs/security/node-key-roles-and-rotation.md). The
 * verifiers of the *signing* roles only ever learn the CURRENT public key, so
 * a rotation silently orphans everything the old key signed — unless the
 * handover itself is a signed, verifiable fact.
 *
 * `key.rotated` is that fact: a statement naming the old and new key (by kid
 * and public key) and the moment the new key takes over, signed by BOTH keys.
 *   - The old-key signature lets a verifier who pinned the old key accept the
 *     new one (the old key vouches for its successor).
 *   - The new-key signature proves the successor is held by whoever ran the
 *     rotation, so a stolen old key alone cannot mint a handover to a key the
 *     attacker does not hold.
 * Chained, the attestations form a key history: for any past timestamp a
 * verifier can name the key that was legitimately signing at that moment
 * (`trustedPublicKeysAt`).
 *
 * Everything here is pure (no env, no DB, no clock unless passed in) so the
 * ceremony can be machine-checked from the operator script, the kernel and
 * tests alike. Private keys are accepted as arguments and never logged,
 * returned or embedded in any result.
 */
import { sha256 } from '@noble/hashes/sha256';
import { canonicalize } from './sign';
import * as crypto from './crypto';

export const KEY_ROTATED_ATTESTATION_TYPE = 'key.rotated' as const;

/** `contextType` a node-issued `key.rotated` attestation is filed under; `contextId` is the NEW kid. */
export const KEY_ROTATED_CONTEXT_TYPE = 'node.key' as const;

const STATEMENT_VERSION = 1;

/**
 * Seed the dev fallback in apps/kernel/src/lib/vault/sealing.ts derives its
 * signing identity from when AUTH_PRIVATE_KEY is unset (#1520). A real
 * rotation must never land on that publicly-predictable key.
 */
const DEV_FALLBACK_SIGNING_SEED = 'dev-vault-signing-key-imajin';

/**
 * Stable per-key identifier: a hash of the public key hex, so it changes iff
 * the key does. Single source of truth — `GET /auth/.well-known/kernel-signing-key`
 * and every `key.rotated` payload must agree on it.
 */
export function computeKeyKid(publicKeyHex: string): string {
  const digest = crypto.bytesToHex(sha256(new TextEncoder().encode(publicKeyHex)));
  return `auth-${digest.slice(0, 16)}`;
}

/** The `payload` of a `key.rotated` attestation. Contains public material and signatures only. */
export interface KeyRotatedPayload {
  oldKid: string;
  newKid: string;
  oldPublicKey: string;
  newPublicKey: string;
  /** ISO-8601 instant the new key became the signing key. */
  effectiveAt: string;
  /** Ed25519 signature by the OLD key over the rotation statement. */
  oldKeySignature: string;
  /** Ed25519 signature by the NEW key over the same statement. */
  newKeySignature: string;
}

export type KeyRotationVerification =
  | { ok: true; payload: KeyRotatedPayload }
  | { ok: false; error: string };

/**
 * The exact string both keys sign. Covers both public keys + kids and the
 * effective instant, so neither signature can be replayed onto a different
 * handover.
 */
export function buildKeyRotationStatement(params: {
  oldPublicKey: string;
  newPublicKey: string;
  effectiveAt: string;
}): string {
  return canonicalize({
    type: KEY_ROTATED_ATTESTATION_TYPE,
    v: STATEMENT_VERSION,
    oldKid: computeKeyKid(params.oldPublicKey),
    newKid: computeKeyKid(params.newPublicKey),
    oldPublicKey: params.oldPublicKey,
    newPublicKey: params.newPublicKey,
    effectiveAt: params.effectiveAt,
  });
}

/**
 * Produce the dual-signed payload. Throws on an invalid key, an unchanged key
 * (a rotation to the same key is a no-op the history must not record) or an
 * unparseable `effectiveAt` — the ceremony fails before anything is signed.
 */
export function createKeyRotatedPayload(params: {
  oldPrivateKey: string;
  newPrivateKey: string;
  /** Defaults to now. */
  effectiveAt?: Date;
}): KeyRotatedPayload {
  const { oldPrivateKey, newPrivateKey } = params;
  if (!crypto.isValidPrivateKey(oldPrivateKey)) {
    throw new Error('old private key is not a valid Ed25519 private key (64 or 96 hex chars)');
  }
  if (!crypto.isValidPrivateKey(newPrivateKey)) {
    throw new Error('new private key is not a valid Ed25519 private key (64 or 96 hex chars)');
  }
  const effectiveDate = params.effectiveAt ?? new Date();
  if (Number.isNaN(effectiveDate.getTime())) {
    throw new TypeError('effectiveAt is not a valid date');
  }

  const oldPublicKey = crypto.getPublicKey(oldPrivateKey);
  const newPublicKey = crypto.getPublicKey(newPrivateKey);
  if (oldPublicKey === newPublicKey) {
    throw new Error('old and new keys are identical — nothing to rotate');
  }

  const effectiveAt = effectiveDate.toISOString();
  const statement = buildKeyRotationStatement({ oldPublicKey, newPublicKey, effectiveAt });
  return {
    oldKid: computeKeyKid(oldPublicKey),
    newKid: computeKeyKid(newPublicKey),
    oldPublicKey,
    newPublicKey,
    effectiveAt,
    oldKeySignature: crypto.signSync(statement, oldPrivateKey),
    newKeySignature: crypto.signSync(statement, newPrivateKey),
  };
}

const PAYLOAD_STRING_FIELDS = [
  'oldKid',
  'newKid',
  'oldPublicKey',
  'newPublicKey',
  'effectiveAt',
  'oldKeySignature',
  'newKeySignature',
] as const;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Fully verify one `key.rotated` payload from untrusted input: shape, that the
 * kids really are the hashes of the named public keys, and BOTH signatures
 * over the rotation statement. Never throws.
 */
export function verifyKeyRotatedPayload(value: unknown): KeyRotationVerification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('key.rotated payload must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const field of PAYLOAD_STRING_FIELDS) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      return fail(`key.rotated payload.${field} must be a non-empty string`);
    }
  }
  const payload = record as unknown as KeyRotatedPayload;

  if (!crypto.isValidPublicKey(payload.oldPublicKey) || !crypto.isValidPublicKey(payload.newPublicKey)) {
    return fail('key.rotated payload carries an invalid public key');
  }
  if (payload.oldPublicKey === payload.newPublicKey) {
    return fail('key.rotated payload names the same key as old and new');
  }
  if (computeKeyKid(payload.oldPublicKey) !== payload.oldKid) {
    return fail('oldKid does not match oldPublicKey');
  }
  if (computeKeyKid(payload.newPublicKey) !== payload.newKid) {
    return fail('newKid does not match newPublicKey');
  }
  if (Number.isNaN(Date.parse(payload.effectiveAt))) {
    return fail('effectiveAt is not a valid ISO-8601 instant');
  }

  const statement = buildKeyRotationStatement(payload);
  if (!crypto.verifySync(payload.oldKeySignature, statement, payload.oldPublicKey)) {
    return fail('oldKeySignature does not verify against the old public key');
  }
  if (!crypto.verifySync(payload.newKeySignature, statement, payload.newPublicKey)) {
    return fail('newKeySignature does not verify against the new public key');
  }
  return { ok: true, payload };
}

/** One key in a verified history. `null` bounds are open: the genesis key has no `validFrom`, the current key no `validUntil`. */
export interface KeyHistoryEntry {
  kid: string;
  publicKey: string;
  validFrom: string | null;
  validUntil: string | null;
}

export type KeyRotationChainVerification =
  | { ok: true; keys: KeyHistoryEntry[]; currentKid: string | null }
  | { ok: false; error: string; index?: number };

/**
 * Verify a set of `key.rotated` payloads as ONE linear key history, in any
 * input order: every payload individually valid, no fork (two successors of
 * one key), no reuse of a retired key, no gaps (each `oldKid` is the previous
 * `newKid`) and non-decreasing `effectiveAt` along the chain.
 *
 * `anchorPublicKey` (optional) pins the chain's genesis: the oldest `oldPublicKey`
 * must equal it. A verifier that pinned a key before any rotation passes that
 * key here; without it the chain is self-consistent but not rooted anywhere.
 * An empty list is a valid empty history (no rotation has happened).
 */
export function verifyKeyRotationChain(
  payloads: readonly unknown[],
  options: { anchorPublicKey?: string } = {},
): KeyRotationChainVerification {
  const verified: KeyRotatedPayload[] = [];
  for (const [index, candidate] of payloads.entries()) {
    const result = verifyKeyRotatedPayload(candidate);
    if (!result.ok) return { ok: false, error: `payload ${index}: ${result.error}`, index };
    verified.push(result.payload);
  }
  if (verified.length === 0) return { ok: true, keys: [], currentKid: null };

  const ordered = orderRotations(verified);
  if (!Array.isArray(ordered)) return ordered;

  if (options.anchorPublicKey !== undefined && ordered[0].oldPublicKey !== options.anchorPublicKey) {
    return fail('key history does not start at the pinned anchor key');
  }

  const keys = toKeyHistory(ordered);
  return { ok: true, keys, currentKid: keys.at(-1)?.kid ?? null };
}

/**
 * Put individually-valid rotations into chain order, or explain why they are
 * not ONE linear history: a fork, no single starting key, a reused key, or a
 * rotation dated before the one that introduced its old key.
 */
function orderRotations(verified: readonly KeyRotatedPayload[]): KeyRotatedPayload[] | { ok: false; error: string } {
  const byOldKid = new Map<string, KeyRotatedPayload>();
  for (const payload of verified) {
    if (byOldKid.has(payload.oldKid)) {
      return fail(`key history forks: more than one rotation away from ${payload.oldKid}`);
    }
    byOldKid.set(payload.oldKid, payload);
  }

  const newKids = new Set(verified.map((payload) => payload.newKid));
  const genesis = verified.filter((payload) => !newKids.has(payload.oldKid));
  if (genesis.length !== 1) {
    return fail('key history has no single starting key (cycle or disconnected rotations)');
  }

  const ordered: KeyRotatedPayload[] = [];
  const seenKids = new Set<string>([genesis[0].oldKid]);
  let cursor: KeyRotatedPayload | undefined = genesis[0];
  while (cursor) {
    if (seenKids.has(cursor.newKid)) {
      return fail(`key history reuses retired key ${cursor.newKid}`);
    }
    const previous = ordered.at(-1);
    if (previous && Date.parse(cursor.effectiveAt) < Date.parse(previous.effectiveAt)) {
      return fail(`rotation to ${cursor.newKid} takes effect before the rotation that introduced ${cursor.oldKid}`);
    }
    ordered.push(cursor);
    seenKids.add(cursor.newKid);
    cursor = byOldKid.get(cursor.newKid);
  }
  if (ordered.length !== verified.length) {
    return fail('key history has rotations that are not part of the chain');
  }
  return ordered;
}

/** The keys of an ordered chain with their validity windows (open at both ends). */
function toKeyHistory(ordered: readonly KeyRotatedPayload[]): KeyHistoryEntry[] {
  const keys: KeyHistoryEntry[] = [
    {
      kid: ordered[0].oldKid,
      publicKey: ordered[0].oldPublicKey,
      validFrom: null,
      validUntil: ordered[0].effectiveAt,
    },
  ];
  for (const [i, rotation] of ordered.entries()) {
    keys.push({
      kid: rotation.newKid,
      publicKey: rotation.newPublicKey,
      validFrom: rotation.effectiveAt,
      validUntil: ordered[i + 1]?.effectiveAt ?? null,
    });
  }
  return keys;
}

/**
 * Public keys that were legitimately signing at `at` according to a verified
 * history (`validFrom <= at < validUntil`). This is how a verifier checks an
 * old attestation after a rotation: try only the key(s) valid at its
 * `issuedAt`, instead of trusting every key ever seen.
 */
export function trustedPublicKeysAt(history: readonly KeyHistoryEntry[], at: Date | number): string[] {
  const instant = typeof at === 'number' ? at : at.getTime();
  return history
    .filter((entry) => {
      const from = entry.validFrom === null ? Number.NEGATIVE_INFINITY : Date.parse(entry.validFrom);
      const until = entry.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(entry.validUntil);
      return from <= instant && instant < until;
    })
    .map((entry) => entry.publicKey);
}

export interface KeyRotationPreflightInput {
  /** The key currently in AUTH_PRIVATE_KEY (still loaded, Phase 1 sweep not yet started or just finished). */
  oldPrivateKey?: string;
  /** The key that will replace it. */
  newPrivateKey?: string;
  /**
   * Length of the AUTH_PREVIOUS_PUBLIC_KEY grace window, in hours. Must outlast
   * the time it takes to restart every verifier that pins the kernel key —
   * corpus reconciles its pin only at boot (apps/corpus/src/lib/kernel-trust.ts).
   */
  graceHours?: number;
  now?: Date;
}

export interface KeyRotationPreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Public identifiers only — never key material. Present when the matching key parsed. */
  oldKey?: { kid: string; publicKey: string };
  newKey?: { kid: string; publicKey: string };
  /** The env values to set on the kernel for the grace window (`.env.example`, #2244). */
  previousKeyEnv?: {
    AUTH_PREVIOUS_PUBLIC_KEY: string;
    AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM: string;
    AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL: string;
  };
}

/** Below this the window is unlikely to cover a normal deploy cycle of every pinning verifier. */
export const MIN_GRACE_HOURS = 24;
export const DEFAULT_GRACE_HOURS = 48;

function describeKey(label: string, privateKey: string | undefined): {
  error?: string;
  key?: { kid: string; publicKey: string };
} {
  if (!privateKey) return { error: `${label} key is not set` };
  if (!crypto.isValidPrivateKey(privateKey)) {
    return { error: `${label} key is not a valid Ed25519 private key (expected 64 hex chars raw, or 96 PKCS#8)` };
  }
  const publicKey = crypto.getPublicKey(privateKey);
  return { key: { kid: computeKeyKid(publicKey), publicKey } };
}

/**
 * Machine check for the pre-swap step of the runbook: refuse to proceed unless
 * the old/new pair is a real rotation. Pure — the operator script supplies the
 * env values and prints this result; it never prints either private key.
 */
export function evaluateKeyRotationPreflight(input: KeyRotationPreflightInput): KeyRotationPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const oldResult = describeKey('old', input.oldPrivateKey);
  const newResult = describeKey('new', input.newPrivateKey);
  if (oldResult.error) errors.push(oldResult.error);
  if (newResult.error) errors.push(newResult.error);

  const oldKey = oldResult.key;
  const newKey = newResult.key;
  if (oldKey && newKey?.publicKey === oldKey.publicKey) {
    errors.push('new key is identical to the old key — nothing to rotate');
  }

  if (newKey) {
    const devKey = crypto.getPublicKey(crypto.bytesToHex(sha256(new TextEncoder().encode(DEV_FALLBACK_SIGNING_SEED))));
    if (newKey.publicKey === devKey) {
      errors.push('new key is the publicly-known dev fallback key (#1520) — generate a fresh one');
    }
  }

  const graceHours = input.graceHours ?? DEFAULT_GRACE_HOURS;
  if (!Number.isFinite(graceHours) || graceHours <= 0) {
    errors.push('graceHours must be a positive number');
  } else if (graceHours < MIN_GRACE_HOURS) {
    warnings.push(
      `grace window of ${graceHours}h is shorter than ${MIN_GRACE_HOURS}h — a verifier that pins the kernel key (corpus) and is not restarted inside the window is left trusting only the old key`,
    );
  }

  let previousKeyEnv: KeyRotationPreflightResult['previousKeyEnv'];
  if (oldKey && errors.length === 0) {
    const now = input.now ?? new Date();
    previousKeyEnv = {
      AUTH_PREVIOUS_PUBLIC_KEY: oldKey.publicKey,
      AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM: now.toISOString(),
      AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL: new Date(now.getTime() + graceHours * 3_600_000).toISOString(),
    };
  }

  return { ok: errors.length === 0, errors, warnings, oldKey, newKey, previousKeyEnv };
}
