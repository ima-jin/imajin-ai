/**
 * Vault proposal execution bridge (#2247).
 *
 * "Chat proposes, canvas signs, the record is the interface" — approving a
 * `source: 'vault'` proposal on the existing /jin operator-approvals rail
 * (#2059/#2152) IS the signing event (UX note on #2241: "Approve = sign =
 * the mint attestation"). This module is what turns that witnessed tap
 * into the actual vault mutation: `decideOperatorApproval` only records
 * that the operator decided something and publishes `operator.approval.
 * decided` — it has no idea what "vault:mint" means, by design (#2152's
 * whole point is an open, kernel-agnostic vocabulary). The decision route
 * calls {@link executeVaultApproval} right after a successful 'approve' on
 * a vault-sourced proposal; everything else (reject/withdraw, every other
 * source) is untouched.
 *
 * Never throws to the caller — every outcome is reported as
 * `{ ok, error? }` so a mutation failure surfaces as `executionError` in
 * the decision response without ever un-recording the operator's decision
 * itself (the signed decision is durable, exactly like an ack; see
 * `decideOperatorApproval`'s own docs).
 */
import { createLogger } from '@imajin/logger';
import type { OperatorApprovalCard } from '../notify/operator-approvals-service';
import { mintKeypair, emitMintedEvents, revokeMintedKey, emitRevokedEvents, emitWithdrawnEvents, type MintKeypairResult } from './mint';
import { grantExistingMintedKey, emitGrantEvents } from './grant';
import { getMintedKeyByDid } from './key-cards';
import { revokeStaticSecretGrant } from './index';
import { getNodeSigningIdentity } from './sealing';
import { resolveVaultAuthorization, type VaultAuthorization } from './authorization';
import type { VaultRevokeTier } from './revoke-tier';

const log = createLogger('kernel');

export type { VaultRevokeTier };
export type { VaultAuthorization };

export interface VaultExecutionResult {
  ok: boolean;
  error?: string;
}

function requireString(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function optionalExpiresAt(detail: Record<string, unknown> | null): Date | null | undefined {
  const raw = detail?.expiresAt;
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function executeMint(card: OperatorApprovalCard, nodeDid: string, authorizedBy: VaultAuthorization): Promise<VaultExecutionResult> {
  const purpose = requireString(card.detail, 'purpose');
  const requesterDid = requireString(card.detail, 'requesterDid');
  if (!purpose || !requesterDid) {
    return { ok: false, error: 'vault:mint proposal is missing purpose/requesterDid' };
  }

  const minted = await mintKeypair({
    purpose,
    requesterDid,
    mintedBy: nodeDid,
    expiresAt: optionalExpiresAt(card.detail) ?? null,
  });
  emitMintedEvents({ minted, purpose, requesterDid, mintedBy: nodeDid, authorizedBy });
  return { ok: true };
}

async function executeGrant(card: OperatorApprovalCard, nodeDid: string, authorizedBy: VaultAuthorization): Promise<VaultExecutionResult> {
  const did = requireString(card.detail, 'did');
  const grantedTo = requireString(card.detail, 'grantedTo');
  if (!did || !grantedTo) {
    return { ok: false, error: 'vault:grant proposal is missing did/grantedTo' };
  }

  const purpose = requireString(card.detail, 'purpose');
  const oneTime = card.detail?.oneTime === true;

  const outcome = await grantExistingMintedKey({
    did,
    grantedTo,
    purpose,
    oneTime,
    expiresAt: optionalExpiresAt(card.detail) ?? null,
    grantedBy: nodeDid,
  });

  if (outcome.status !== 'ok') {
    return { ok: false, error: `vault:grant failed — ${outcome.status}` };
  }

  const mintedKey = await getMintedKeyByDid(did);
  emitGrantEvents({
    grantId: outcome.grantId,
    did,
    field: mintedKey?.field ?? '',
    grantedTo,
    grantedBy: nodeDid,
    authorizedBy,
  });
  return { ok: true };
}

/**
 * Rotate = mint new -> grant same consumer -> revoke old, composed as ONE
 * signed proposal (UX note #5) — achievable directly from the two existing
 * primitives since `mintKeypair` already grants atomically to whichever
 * `requesterDid` is named, so "grant same consumer" just means passing the
 * OLD key's `requestedBy` through as the new mint's `requesterDid`.
 *
 * A SAGA (#2247 review): mint and "grant same consumer" are already atomic
 * as one unit (`mintKeypair` either fully succeeds, producing a usable new
 * key, or throws with nothing new created) — so the only realistic
 * post-mint-success failure point is revoking the OLD key. If that revoke
 * fails for any reason OTHER than "someone already revoked it"
 * (`already_revoked` is a success — the goal, an inactive old key, is
 * already met), the just-minted NEW key is immediately tombstoned too
 * (cleanup, so the rotate never leaves two live keys) and the whole
 * proposal is reported failed with the step that failed named in the
 * error, so the record shows exactly what happened rather than a
 * dangling live key nobody accounts for.
 */
async function executeRotate(card: OperatorApprovalCard, nodeDid: string, authorizedBy: VaultAuthorization): Promise<VaultExecutionResult> {
  const oldDid = requireString(card.detail, 'did');
  if (!oldDid) {
    return { ok: false, error: 'vault:rotate proposal is missing did' };
  }

  const oldRecord = await getMintedKeyByDid(oldDid);
  if (!oldRecord) {
    return { ok: false, error: `vault:rotate — no minted key found for did '${oldDid}'` };
  }

  const purpose = requireString(card.detail, 'purpose') ?? oldRecord.purpose;
  const requesterDid = requireString(card.detail, 'requesterDid') ?? oldRecord.requestedBy;

  let minted: MintKeypairResult;
  try {
    minted = await mintKeypair({
      purpose,
      requesterDid,
      mintedBy: nodeDid,
      expiresAt: optionalExpiresAt(card.detail) ?? null,
    });
  } catch (err) {
    // Nothing new was created (mintKeypair's own seal+grant is atomic as a
    // unit) — no cleanup needed, only report the failed step.
    log.error({ err: String(err), proposalId: card.proposalId, oldDid }, "vault:rotate failed at step 'mint'");
    return { ok: false, error: "vault:rotate failed at step 'mint'" };
  }
  emitMintedEvents({ minted, purpose, requesterDid, mintedBy: nodeDid, authorizedBy });

  let revokeOutcome;
  try {
    revokeOutcome = await revokeMintedKey({ did: oldDid, revokedBy: nodeDid });
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId, oldDid, newDid: minted.did }, "vault:rotate failed at step 'revoke' — rolling back the new key");
    await rollBackMintedKey(minted, nodeDid, authorizedBy);
    return { ok: false, error: "vault:rotate failed at step 'revoke' — new key was rolled back (tombstoned)" };
  }

  if (revokeOutcome.status === 'not_found') {
    // The old key vanished out from under this rotate (a genuine race, or
    // caller error) — the new key must not be left dangling as the only
    // record of what happened, so roll it back and report the failure.
    log.error({ proposalId: card.proposalId, oldDid, newDid: minted.did }, "vault:rotate failed at step 'revoke' (old key not found) — rolling back the new key");
    await rollBackMintedKey(minted, nodeDid, authorizedBy);
    return { ok: false, error: "vault:rotate failed at step 'revoke' — old key not found; new key was rolled back (tombstoned)" };
  }
  if (revokeOutcome.status === 'revoked') {
    emitRevokedEvents(revokeOutcome.record, nodeDid, authorizedBy);
  }
  // 'already_revoked' on the OLD key is a success for this saga — the
  // outcome it exists to guarantee (old key inactive) already held.

  return { ok: true };
}

/** Tombstone a just-minted key as part of the rotate saga's cleanup path, emitting the same revoked events a direct revoke would. Never throws — a cleanup failure is logged but does not change the caller's already-decided failure result. */
async function rollBackMintedKey(minted: MintKeypairResult, nodeDid: string, authorizedBy: VaultAuthorization): Promise<void> {
  try {
    const outcome = await revokeMintedKey({ did: minted.did, revokedBy: nodeDid });
    if (outcome.status === 'revoked') {
      emitRevokedEvents(outcome.record, nodeDid, authorizedBy);
    }
  } catch (err) {
    log.error({ err: String(err), did: minted.did }, 'vault:rotate cleanup — failed to roll back the new key; it may be dangling');
  }
}

/**
 * Revoke, tiered (UX note #5): 'withdraw' stops future fetches without
 * touching the record — but, per #2247 review, still emits a
 * `vault.key.withdrawn` event + attestation so the record remembers THAT
 * it was withdrawn (only when a grant was actually deactivated — a
 * withdraw against a field with no active grant is a no-op and mints no
 * record of an action that didn't happen). 'tombstone'/'destroy' both map
 * onto the existing `revokeMintedKey` soft-tombstone (mark the record
 * revoked + crypto-erase the grant's wrapped key material) — there is no
 * harder-destroy primitive in this codebase yet (see the #2242 PR
 * description's own note on a deferred harder tier), so 'destroy' is
 * currently identical to 'tombstone' beyond its copy. Flagged as a
 * DECISION FOR RYAN in the PR description rather than silently treated as
 * fully implemented.
 */
async function executeRevoke(card: OperatorApprovalCard, nodeDid: string, authorizedBy: VaultAuthorization): Promise<VaultExecutionResult> {
  const did = requireString(card.detail, 'did');
  if (!did) {
    return { ok: false, error: 'vault:revoke proposal is missing did' };
  }
  const tierRaw = requireString(card.detail, 'tier');
  const tier: VaultRevokeTier = tierRaw === 'destroy' || tierRaw === 'tombstone' ? tierRaw : 'withdraw';

  const record = await getMintedKeyByDid(did);
  if (!record) {
    return { ok: false, error: `vault:revoke — no minted key found for did '${did}'` };
  }

  if (tier === 'withdraw') {
    // Stop future fetches without tombstoning the record itself — the
    // key card still shows 'active' with a withdrawn grant, distinct from
    // the full tombstone below.
    const withdrawn = await revokeStaticSecretGrant(record.field, record.requestedBy);
    if (withdrawn) {
      emitWithdrawnEvents(record, nodeDid, authorizedBy);
    }
    return { ok: true };
  }

  const outcome = await revokeMintedKey({ did, revokedBy: nodeDid });
  if (outcome.status === 'not_found') {
    return { ok: false, error: `vault:revoke — no minted key found for did '${did}'` };
  }
  if (outcome.status === 'revoked') {
    emitRevokedEvents(outcome.record, nodeDid, authorizedBy);
  }
  return { ok: true };
}

/**
 * "Claim pending service" (UX note #3) is the claimable pending-service
 * self-registration/pairing moment. #2243 (loadFromVault fetch-at-boot,
 * merged into main) deliberately does NOT implement it — per its own PR
 * description, that pairing flow needs a service/host-shaped extension of
 * the #1834 claimable-stub primitive that doesn't exist yet, and is
 * flagged there as its own follow-up. Stubbed here so the proposal SHAPE
 * exists and is testable, but nothing executes — TODO(#2243): wire this up
 * once that follow-up lands.
 */
function executeClaim(): Promise<VaultExecutionResult> {
  return Promise.resolve({ ok: false, error: 'vault:claim execution is stubbed pending #2243' });
}

/**
 * Execute the vault mutation behind an approved `source: 'vault'`
 * proposal. Called by the decision route immediately after
 * `decideOperatorApproval` records `decision: 'approve'`. Returns
 * `{ ok: false, error }` for an unrecognized kind or a failed mutation —
 * never throws.
 *
 * The single fail-closed choke point (#2247, the signing-roles ruling):
 * every vault:* kind requires a genuine operator countersignature on its
 * decision before ANY mutation runs — `resolveVaultAuthorization` returns
 * `null` when one is missing, and execution refuses outright. The
 * resulting audit-trail reference (`authorizedBy`) and the executing
 * identity (always the NODE — `getNodeSigningIdentity()`, matching
 * `requireMintAuthority`'s own invariant for a direct API call) are then
 * threaded into every executor uniformly, so no individual kind can
 * accidentally skip the gate or issue its mechanical attestation under
 * the operator's DID.
 */
export async function executeVaultApproval(card: OperatorApprovalCard): Promise<VaultExecutionResult> {
  const authorizedBy = resolveVaultAuthorization(card);
  if (!authorizedBy) {
    log.warn({ proposalId: card.proposalId, kind: card.kind }, 'Vault proposal execution refused — missing or unverified operator countersignature');
    return { ok: false, error: `${card.kind} requires a countersigned operator decision` };
  }

  try {
    const nodeDid = getNodeSigningIdentity().senderDid;
    switch (card.kind) {
      case 'vault:mint':
        return await executeMint(card, nodeDid, authorizedBy);
      case 'vault:grant':
        return await executeGrant(card, nodeDid, authorizedBy);
      case 'vault:rotate':
        return await executeRotate(card, nodeDid, authorizedBy);
      case 'vault:revoke':
        return await executeRevoke(card, nodeDid, authorizedBy);
      case 'vault:claim':
        return await executeClaim();
      default:
        return { ok: false, error: `Unrecognized vault proposal kind '${card.kind}'` };
    }
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId, kind: card.kind }, 'Vault proposal execution failed');
    return { ok: false, error: 'Vault proposal execution failed' };
  }
}
