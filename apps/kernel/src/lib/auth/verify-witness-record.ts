/**
 * S5 witness-record verifier (#2684) — verifies kernel witness records
 * (docs/security/node-key-roles-and-rotation.md §2, role S5) across a node-key
 * rotation by consuming the `key.rotated` attestation history (#2081).
 *
 * S5 records are signed by the node's vault-derived signing identity
 * (`getNodeSigningIdentity()`, DID `did:imajin:<first 16 hex of pubkey>`), e.g.
 * the `{ payload, signature, senderPubkey }` stored on an
 * `operator.approval.decided` row. After a rotation the DID itself changes, and
 * a verifier that resolves only the current key rejects every older record.
 * This verifier instead:
 *
 *   1. reads the node's `key.rotated` chain (issuer = the relay_config node DID)
 *      and verifies it as ONE linear history — dual signatures, no fork, no
 *      reuse, no gap — that ends at the key the node is signing with now;
 *   2. resolves the key(s) that history says were signing at the record's
 *      timestamp (`trustedPublicKeysAt`);
 *   3. requires the record's claimed `senderPubkey` to be one of them, and
 *      verifies the witness signature against it.
 *
 * Fails closed, never throws: a broken or forked chain, a chain that does not
 * lead to the current key, a key the history has never seen, a key outside its
 * validity window, an unparseable timestamp and a bad signature are each a
 * distinct `{ ok: false, code }`. A node that has never rotated has an empty
 * history and exactly one trusted key, the current one.
 *
 * Not covered: the operator countersign embedded in the same decision (signed
 * by the operator's own key — see `notify/operator-countersign.ts`), and
 * verifying that the DID the node reports for itself was never rebound.
 */
import { canonicalize, crypto as authCrypto, trustedPublicKeysAt, verifyKeyRotationChain, type KeyHistoryEntry } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { resolveNodeDid } from '@/src/lib/kernel/node-identity';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { loadStoredRotationPayloads } from './node-key-rotation';

const log = createLogger('kernel');

export type WitnessRecordFailureCode =
  | 'invalid-record'
  | 'invalid-timestamp'
  | 'node-did-unavailable'
  | 'history-unavailable'
  | 'history-broken'
  | 'history-not-current'
  | 'unknown-key'
  | 'key-not-valid-at-time'
  | 'did-mismatch'
  | 'bad-signature';

export type WitnessRecordVerification =
  | {
      ok: true;
      /** Public key that signed the record. */
      publicKey: string;
      /** True when the record was signed by a key the node has since rotated away from. */
      retiredKey: boolean;
    }
  | { ok: false; code: WitnessRecordFailureCode; error: string };

export interface WitnessRecord {
  /** The exact string that was signed (for approvals: `canonicalize(payload)`). */
  message: string;
  /** Hex Ed25519 signature over `message`. */
  signature: string;
  /** Hex Ed25519 public key the record claims signed it. */
  senderPubkey: string;
  /** When the kernel witnessed the event — selects the key from the rotation history. */
  witnessedAt: Date | string | number;
  /** Optional: the vault-derived DID the record claims; must match `senderPubkey`. */
  witnessDid?: string;
}

export interface VerifyWitnessRecordOptions {
  /** Pins the chain genesis to a key the verifier trusted before the first rotation. */
  anchorPublicKey?: string;
}

function fail(code: WitnessRecordFailureCode, error: string): WitnessRecordVerification {
  return { ok: false, code, error };
}

/** The vault-derived DID for a node signing key (mirrors `getNodeSigningIdentity`). */
function witnessDidForKey(publicKey: string): string {
  return `did:imajin:${publicKey.toLowerCase().slice(0, 16)}`;
}

function toInstant(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' ? value : Date.parse(value);
}

type HistoryResult = { ok: true; keys: KeyHistoryEntry[] } | { ok: false; failure: WitnessRecordVerification };

/** Verified key history ending at the key the node is signing with; a never-rotated node is one open-ended key. */
async function loadWitnessKeyHistory(options: VerifyWitnessRecordOptions): Promise<HistoryResult> {
  const { did: nodeDid, source } = await resolveNodeDid();
  if (!nodeDid || source !== 'relay_config') {
    return {
      ok: false,
      failure: fail('node-did-unavailable', 'node DID is not configured from relay.relay_config.imajin_did — no key.rotated history to consult'),
    };
  }

  let stored: unknown[];
  let currentPublicKey: string;
  try {
    stored = await loadStoredRotationPayloads(nodeDid);
    currentPublicKey = getNodeSigningIdentity().senderPubkey;
  } catch (err) {
    log.warn({ err }, 'witness-record verification could not load key history');
    return { ok: false, failure: fail('history-unavailable', 'key.rotated history or the current node key could not be loaded') };
  }

  const chain = verifyKeyRotationChain(stored, { anchorPublicKey: options.anchorPublicKey });
  if (!chain.ok) return { ok: false, failure: fail('history-broken', `key history invalid: ${chain.error}`) };

  if (chain.keys.length === 0) {
    return { ok: true, keys: [{ kid: '', publicKey: currentPublicKey, validFrom: null, validUntil: null }] };
  }
  if (chain.keys.at(-1)?.publicKey !== currentPublicKey) {
    return {
      ok: false,
      failure: fail('history-not-current', 'key history does not end at the key the node is signing with — a rotation was not attested'),
    };
  }
  return { ok: true, keys: chain.keys };
}

/** Reject a record whose shape could not have come from the kernel, before any DB access. */
function validateRecordShape(record: WitnessRecord): WitnessRecordVerification | null {
  if (
    typeof record.message !== 'string' ||
    typeof record.signature !== 'string' ||
    typeof record.senderPubkey !== 'string' ||
    !authCrypto.isValidPublicKey(record.senderPubkey)
  ) {
    return fail('invalid-record', 'witness record needs a message, a signature and a valid Ed25519 senderPubkey');
  }
  if (record.witnessDid !== undefined && record.witnessDid !== witnessDidForKey(record.senderPubkey)) {
    return fail('did-mismatch', 'witnessDid is not the DID derived from senderPubkey');
  }
  return null;
}

/**
 * Verify an S5 witness record against the node's `key.rotated` history.
 * See the module doc for the exact rules; never throws.
 */
export async function verifyWitnessRecord(
  record: WitnessRecord,
  options: VerifyWitnessRecordOptions = {},
): Promise<WitnessRecordVerification> {
  const instant = toInstant(record.witnessedAt);
  if (Number.isNaN(instant)) return fail('invalid-timestamp', 'witnessedAt is not a valid instant');

  const malformed = validateRecordShape(record);
  if (malformed) return malformed;

  const history = await loadWitnessKeyHistory(options);
  if (!history.ok) return history.failure;

  const senderPubkey = record.senderPubkey.toLowerCase();
  const known = history.keys.some((key) => key.publicKey === senderPubkey);
  if (!known) return fail('unknown-key', 'senderPubkey is not in the node key history');
  if (!trustedPublicKeysAt(history.keys, instant).includes(senderPubkey)) {
    return fail('key-not-valid-at-time', 'senderPubkey was not the node signing key at witnessedAt');
  }

  if (!authCrypto.verifySync(record.signature, record.message, senderPubkey)) {
    return fail('bad-signature', 'witness signature does not verify against senderPubkey');
  }
  return { ok: true, publicKey: senderPubkey, retiredKey: history.keys.at(-1)?.publicKey !== senderPubkey };
}

/**
 * Verify the kernel witness record stored on an approved/decided
 * `operator.approval.decided` row (`operator_approvals.decision`, written by
 * `decideOperatorApproval`): `{ payload, signature, senderPubkey }`, signed
 * over `canonicalize(payload)`, witnessed at `payload.decidedAt`.
 */
export async function verifyOperatorApprovalWitnessRecord(
  decision: unknown,
  options: VerifyWitnessRecordOptions = {},
): Promise<WitnessRecordVerification> {
  if (typeof decision !== 'object' || decision === null) {
    return fail('invalid-record', 'decision is not an object');
  }
  const { payload, signature, senderPubkey } = decision as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null) {
    return fail('invalid-record', 'decision.payload is not an object');
  }
  const { decidedAt } = payload as { decidedAt?: unknown };
  if (typeof decidedAt !== 'string') {
    return fail('invalid-timestamp', 'decision.payload.decidedAt is missing');
  }
  if (typeof signature !== 'string' || typeof senderPubkey !== 'string') {
    return fail('invalid-record', 'decision needs a signature and a senderPubkey');
  }
  return verifyWitnessRecord({ message: canonicalize(payload), signature, senderPubkey, witnessedAt: decidedAt }, options);
}
