/**
 * Pure (no DB) half of the operator countersignature (#2082, #2693): the
 * exact bytes the operator signs, and the read-side assessment of whether a
 * stored decision's signature covers its chosen `mode`.
 *
 * Kept free of `@/src/db` so the Record lane read model can use it without
 * dragging key resolution in — {@link assessDecidedModeCountersignature}
 * checks the signature against the `keyId` embedded in the payload, which
 * the kernel already matched to the operator DID's registered key at
 * decide time (`verifyOperatorCountersignature`).
 */
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { OperatorCountersignFields } from './operator-approvals';

/** What the Record lane shows for a decision whose signature predates #2693. */
export const LETTER_NOT_COUNTERSIGNED_LABEL = 'letter not countersigned';

/**
 * The canonical string the operator signs (#2693): `{contentHash,
 * decidedAt, decision}` plus `mode` ONLY when the decision carries one. A
 * decision without a mode therefore signs byte-for-byte what #2082 signed.
 * `canonicalize` renders an `undefined` value as the literal `undefined`,
 * so `mode` is left off the object entirely rather than set to undefined.
 */
export function countersignedMessage(fields: OperatorCountersignFields): string {
  const { contentHash, decision, decidedAt, mode } = fields;
  const base = { contentHash, decision, decidedAt };
  return canonicalize(mode === undefined ? base : { ...base, mode });
}

/**
 * - `countersigned` — the decision carries a `mode` and the operator's
 *   signature covers it.
 * - `not-countersigned` — the decision carries a `mode`, but the signature
 *   only verifies WITHOUT it (signed before #2693): the letter is witnessed
 *   by the node, not signed by the operator. Shown as
 *   {@link LETTER_NOT_COUNTERSIGNED_LABEL}; NOT an invalid decision.
 * - `not-applicable` — nothing to cover (no `mode`, no operator signature,
 *   or not an assessable decided payload).
 * - `invalid` — an operator signature is present but verifies against
 *   neither shape (e.g. `mode` altered after signing).
 */
export type ModeCountersignStatus = 'countersigned' | 'not-countersigned' | 'not-applicable' | 'invalid';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bareHash(wire: string): string {
  return wire.toLowerCase().startsWith('sha256:') ? wire.slice(7) : wire;
}

function verifies(sig: string, fields: OperatorCountersignFields, keyId: string): boolean {
  try {
    return authCrypto.verifySync(sig, countersignedMessage(fields), keyId);
  } catch {
    return false;
  }
}

/**
 * Assess a stored `operator.approval.decided` payload (#2693 back-compat).
 * Never throws; a payload that can't be evaluated is `not-applicable`.
 */
export function assessDecidedModeCountersignature(payload: unknown): ModeCountersignStatus {
  if (typeof payload !== 'object' || payload === null) return 'not-applicable';
  const p = payload as Record<string, unknown>;
  const signature = p.operatorSignature as Record<string, unknown> | undefined;
  const keyId = str(signature?.keyId);
  const sig = str(signature?.sig);
  const contentHash = str(p.contentHash);
  const decision = str(p.decision);
  const decidedAt = str(p.decidedAt);
  if (!keyId || !sig || !contentHash || !decision || !decidedAt) return 'not-applicable';

  const base = { contentHash: bareHash(contentHash), decision: decision as OperatorCountersignFields['decision'], decidedAt };
  const mode = str(p.mode);

  if (mode === undefined) {
    return verifies(sig, base, keyId) ? 'not-applicable' : 'invalid';
  }
  if (verifies(sig, { ...base, mode }, keyId)) return 'countersigned';
  return verifies(sig, base, keyId) ? 'not-countersigned' : 'invalid';
}
