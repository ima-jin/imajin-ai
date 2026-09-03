/**
 * Recovery codes — the self-custody key-recovery floor (#1250 Phase 1).
 *
 * Core design principle (from the issue): the user is NEVER handed a key.
 * Recovery only ever *authorizes* a fresh, user-generated key
 * (`newPublicKeyHex`) — no key material ever travels between client and
 * server, matching the existing #401 chain-update model.
 *
 * Honesty disclosure: a recovery code is verified BY THE SERVER. That makes
 * this path server-verified, not trustless — the same trust class as an
 * email magic-link (see #1250's recovery ladder). This is disclosed to
 * callers via `RECOVERY_DISCLOSURE` rather than presented as cryptographic
 * proof.
 *
 * Rotation semantics mirror `/auth/api/identity/[did]/rotate` (#401): update
 * `identities.publicKey` + reset `keyRoles` to the single-key-all-roles
 * default, and invalidate all sessions. A DFOS identity chain (if any)
 * cannot be *extended* here — extending it cryptographically requires a
 * signature from a controller key, and the whole point of recovery is that
 * the user no longer has one. So an existing chain is marked
 * `isDeleted = true` (chain bridging is dropped on recovery; the user may
 * re-link a fresh chain from their new key afterwards). See the PR's
 * "Decisions for review" section.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { eq, and, isNull } from 'drizzle-orm';
import { db, identities, identityChains, tokens, recoveryCodes, recoveryAttempts, type RecoveryCode } from '@/src/db';
import { createLogger } from '@imajin/logger';
import { send } from '@imajin/notify';
import { emitRecoveryCodesGeneratedAttestation, emitRecoveryRedeemedAttestation } from './emit-recovery-attestation';

const log = createLogger('kernel');

export const RECOVERY_DISCLOSURE =
  'Recovery codes are verified by the server, not by cryptographic proof — this recovery path is not trustless (same trust class as an email magic-link).';

// ── Code count ──────────────────────────────────────────────────────────
export const DEFAULT_RECOVERY_CODE_COUNT = 10;
const MIN_RECOVERY_CODE_COUNT = 4;
const MAX_RECOVERY_CODE_COUNT = 20;

export function resolveRecoveryCodeCount(requested?: number): number {
  const envDefault = Number(process.env.RECOVERY_CODE_COUNT);
  const base = requested ?? (Number.isFinite(envDefault) && envDefault > 0 ? envDefault : DEFAULT_RECOVERY_CODE_COUNT);
  return Math.min(MAX_RECOVERY_CODE_COUNT, Math.max(MIN_RECOVERY_CODE_COUNT, Math.trunc(base)));
}

// ── Code format: Crockford base32, grouped, ≥128 bits effective ────────
// 17 random bytes = 136 bits > 128-bit floor. Crockford excludes I/L/O/U to
// avoid visual ambiguity. Groups of 4 for readability: "XXXX-XXXX-...".
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_ENTROPY_BYTES = 17;
const CODE_GROUP_SIZE = 4;

function encodeCrockfordBase32(bytes: Uint8Array): string {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += CROCKFORD_ALPHABET[Number.parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder !== 0) {
    const last = bits.slice(bits.length - remainder).padEnd(5, '0');
    output += CROCKFORD_ALPHABET[Number.parseInt(last, 2)];
  }
  return output;
}

/** Generate one user-facing recovery code, e.g. "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX". */
export function generateRecoveryCodePlaintext(): string {
  const raw = encodeCrockfordBase32(randomBytes(CODE_ENTROPY_BYTES));
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += CODE_GROUP_SIZE) {
    groups.push(raw.slice(i, i + CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/** Normalize user input for hashing/comparison: strip formatting, upper-case. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replaceAll(/[^0-9A-Z]/g, '');
}

// ── Hashing: scrypt (Node built-in, already used in this codebase for
// AES-256-GCM secrets — see src/lib/auth/encrypt.ts). Chosen over adding a
// new argon2/bcrypt dependency to avoid a native-binding dependency in a
// Next.js deployment; see PR "Decisions for review" for the tradeoff. ────
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/** Hash a normalized recovery code. Never store the plaintext. */
export function hashRecoveryCode(normalizedCode: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(normalizedCode, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time verification of a normalized code against a stored hash. */
export function verifyRecoveryCodeHash(normalizedCode: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(normalizedCode, salt, expected.length, { N, r, p });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch (err) {
    log.error({ err: String(err) }, '[recovery-codes] hash verification error');
    return false;
  }
}

// ── Storage ──────────────────────────────────────────────────────────────

/**
 * Generate a fresh batch of N recovery codes for a DID, invalidating any
 * previously-active codes first (regeneration invalidates the old set).
 * Returns the plaintext codes — the ONLY time they are ever visible.
 */
export async function generateRecoveryCodes(did: string, requestedCount?: number): Promise<string[]> {
  const count = resolveRecoveryCodeCount(requestedCount);
  await invalidateAllRecoveryCodes(did);

  const plaintextCodes: string[] = [];
  const rows: (typeof recoveryCodes.$inferInsert)[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const plain = generateRecoveryCodePlaintext();
    plaintextCodes.push(plain);
    rows.push({
      id: `rc_${nanoid(16)}`,
      did,
      codeHash: hashRecoveryCode(normalizeRecoveryCode(plain)),
      createdAt: now,
    });
  }

  await db.insert(recoveryCodes).values(rows);

  emitRecoveryCodesGeneratedAttestation({ did, count: plaintextCodes.length }).catch((err) =>
    log.error({ err: String(err), did }, '[recovery-codes] recovery.codes.generated attestation failed (non-fatal)'),
  );

  return plaintextCodes;
}

/**
 * Status for the authenticated owner: how many codes are currently active,
 * and when the active batch was generated. Never returns codes or hashes.
 */
export async function getRecoveryCodeStatus(did: string): Promise<{ remaining: number; generatedAt: string | null }> {
  const activeCodes = await db
    .select()
    .from(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.did, did),
        isNull(recoveryCodes.usedAt),
        isNull(recoveryCodes.invalidatedAt),
      ),
    );

  if (activeCodes.length === 0) {
    return { remaining: 0, generatedAt: null };
  }

  const generatedAt = activeCodes.reduce((latest: Date, row: RecoveryCode) => {
    const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string);
    return createdAt > latest ? createdAt : latest;
  }, new Date(0));

  return { remaining: activeCodes.length, generatedAt: generatedAt.toISOString() };
}

/** Bulk-invalidate every currently-active recovery code for a DID. */
export async function invalidateAllRecoveryCodes(did: string): Promise<void> {
  await db
    .update(recoveryCodes)
    .set({ invalidatedAt: new Date() })
    .where(
      and(
        eq(recoveryCodes.did, did),
        isNull(recoveryCodes.usedAt),
        isNull(recoveryCodes.invalidatedAt),
      ),
    );
}

// ── Audit log ────────────────────────────────────────────────────────────

export type RecoveryAttemptOutcome =
  | 'success'
  | 'invalid_code'
  | 'no_active_codes'
  | 'not_self_custody'
  | 'identity_not_found'
  | 'invalid_public_key'
  | 'public_key_conflict'
  | 'rate_limited'
  // Proof-of-new-key challenge/response (added alongside the challenge
  // endpoint) — the caller must prove possession of `newPublicKeyHex`'s
  // private key by signing a server-issued challenge before a code is even
  // checked. Both logged from the route layer, which owns the challenge
  // lookup and signature verification (see recovery-codes/verify/route.ts).
  | 'invalid_challenge'
  | 'invalid_proof';

export async function logRecoveryAttempt(params: {
  did: string;
  ip: string;
  outcome: RecoveryAttemptOutcome;
}): Promise<void> {
  try {
    await db.insert(recoveryAttempts).values({
      id: `ratt_${nanoid(16)}`,
      did: params.did,
      ip: params.ip,
      outcome: params.outcome,
      createdAt: new Date(),
    });
  } catch (err) {
    log.error({ err: String(err) }, '[recovery-codes] failed to write audit log row');
  }
}

// ── Redemption (the recovery-authorized rotation) ───────────────────────

const HEX_ED25519_PUBLIC_KEY = /^[0-9a-f]{64}$/i;

export type RedeemRecoveryCodeResult =
  | { ok: true; sessionsInvalidated: true; chainDeprecated: boolean; disclosure: string }
  | { ok: false; reason: RecoveryAttemptOutcome };

/**
 * Verify a submitted recovery code for `did` and, on success, authorize a
 * #401-style rotation to `newPublicKeyHex`. Callers are responsible for
 * rate limiting (per-DID and per-IP) before calling this — every outcome,
 * including ones the caller short-circuits on, should still be audited via
 * `logRecoveryAttempt`.
 */
export async function redeemRecoveryCode(params: {
  did: string;
  code: string;
  newPublicKeyHex: string;
  ip: string;
}): Promise<RedeemRecoveryCodeResult> {
  const { did, ip } = params;

  if (!HEX_ED25519_PUBLIC_KEY.test(params.newPublicKeyHex)) {
    await logRecoveryAttempt({ did, ip, outcome: 'invalid_public_key' });
    return { ok: false, reason: 'invalid_public_key' };
  }

  const [identity] = await db.select().from(identities).where(eq(identities.id, did)).limit(1);
  if (!identity) {
    await logRecoveryAttempt({ did, ip, outcome: 'identity_not_found' });
    return { ok: false, reason: 'identity_not_found' };
  }
  if (identity.tier === 'soft') {
    await logRecoveryAttempt({ did, ip, outcome: 'not_self_custody' });
    return { ok: false, reason: 'not_self_custody' };
  }

  const activeCodes = await db
    .select()
    .from(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.did, did),
        isNull(recoveryCodes.usedAt),
        isNull(recoveryCodes.invalidatedAt),
      ),
    );

  if (activeCodes.length === 0) {
    await logRecoveryAttempt({ did, ip, outcome: 'no_active_codes' });
    return { ok: false, reason: 'no_active_codes' };
  }

  const normalized = normalizeRecoveryCode(params.code);
  const matched = activeCodes.find((row: RecoveryCode) => verifyRecoveryCodeHash(normalized, row.codeHash));

  if (!matched) {
    await logRecoveryAttempt({ did, ip, outcome: 'invalid_code' });
    return { ok: false, reason: 'invalid_code' };
  }

  // Single-use: mark the redeemed code used, then invalidate the rest —
  // this redemption IS a rotation, so "ALL codes invalidated on rotation"
  // applies to the remaining unused codes in the same batch.
  const now = new Date();
  await db.update(recoveryCodes).set({ usedAt: now }).where(eq(recoveryCodes.id, matched.id));
  await invalidateAllRecoveryCodes(did);

  try {
    await db
      .update(identities)
      .set({ publicKey: params.newPublicKeyHex, keyRoles: null, updatedAt: now })
      .where(eq(identities.id, did));
  } catch (err) {
    log.error({ err: String(err), did }, '[recovery-codes] rotation update failed (public key conflict?)');
    await logRecoveryAttempt({ did, ip, outcome: 'public_key_conflict' });
    return { ok: false, reason: 'public_key_conflict' };
  }

  // Best-effort: an existing DFOS chain cannot be cryptographically extended
  // without the (now-lost) controller key, so mark it deprecated rather
  // than leaving a stale chain that no longer matches identities.publicKey.
  let chainDeprecated = false;
  try {
    const [chain] = await db.select().from(identityChains).where(eq(identityChains.did, did)).limit(1);
    if (chain && !chain.isDeleted) {
      await db.update(identityChains).set({ isDeleted: true, updatedAt: now }).where(eq(identityChains.did, did));
      chainDeprecated = true;
    }
  } catch (err) {
    log.error({ err: String(err), did }, '[recovery-codes] chain deprecation failed (non-fatal)');
  }

  // Invalidate all existing sessions — same effect as /rotate.
  await db.delete(tokens).where(eq(tokens.identityId, did));

  await logRecoveryAttempt({ did, ip, outcome: 'success' });

  // Notify all account channels (email at minimum) — silent recovery is
  // takeover. Fire-and-forget: never block the response on notify delivery.
  send({
    to: did,
    scope: 'auth:recovery-code-used',
    urgency: 'urgent',
    data: { did, occurredAt: now.toISOString() },
  }).catch((err) => {
    log.error({ err: String(err), did }, '[recovery-codes] recovery-used notification failed (non-fatal)');
  });

  emitRecoveryRedeemedAttestation({ did }).catch((err) =>
    log.error({ err: String(err), did }, '[recovery-codes] recovery.redeemed attestation failed (non-fatal)'),
  );

  return { ok: true, sessionsInvalidated: true, chainDeprecated, disclosure: RECOVERY_DISCLOSURE };
}
