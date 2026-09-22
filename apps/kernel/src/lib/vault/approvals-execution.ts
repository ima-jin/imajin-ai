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
import { mintKeypair, emitMintedEvents, revokeMintedKey, emitRevokedEvents } from './mint';
import { grantExistingMintedKey, emitGrantEvents } from './grant';
import { getMintedKeyByDid } from './key-cards';
import { revokeStaticSecretGrant } from './index';
import type { VaultRevokeTier } from './revoke-tier';

const log = createLogger('kernel');

export type { VaultRevokeTier };

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

async function executeMint(card: OperatorApprovalCard): Promise<VaultExecutionResult> {
  const purpose = requireString(card.detail, 'purpose');
  const requesterDid = requireString(card.detail, 'requesterDid');
  if (!purpose || !requesterDid) {
    return { ok: false, error: 'vault:mint proposal is missing purpose/requesterDid' };
  }

  const minted = await mintKeypair({
    purpose,
    requesterDid,
    mintedBy: card.decision?.decidedBy ?? card.operatorDid,
    expiresAt: optionalExpiresAt(card.detail) ?? null,
  });
  emitMintedEvents({ minted, purpose, requesterDid, mintedBy: card.operatorDid });
  return { ok: true };
}

async function executeGrant(card: OperatorApprovalCard): Promise<VaultExecutionResult> {
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
    grantedBy: card.operatorDid,
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
    grantedBy: card.operatorDid,
  });
  return { ok: true };
}

/**
 * Rotate = mint new -> grant same consumer -> revoke old, composed as ONE
 * signed proposal (UX note #5) — achievable directly from the two existing
 * primitives since `mintKeypair` already grants atomically to whichever
 * `requesterDid` is named, so "grant same consumer" just means passing the
 * OLD key's `requestedBy` through as the new mint's `requesterDid`.
 */
async function executeRotate(card: OperatorApprovalCard): Promise<VaultExecutionResult> {
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

  const minted = await mintKeypair({
    purpose,
    requesterDid,
    mintedBy: card.operatorDid,
    expiresAt: optionalExpiresAt(card.detail) ?? null,
  });
  emitMintedEvents({ minted, purpose, requesterDid, mintedBy: card.operatorDid });

  const revokeOutcome = await revokeMintedKey({ did: oldDid, revokedBy: card.operatorDid });
  if (revokeOutcome.status === 'revoked') {
    emitRevokedEvents(revokeOutcome.record, card.operatorDid);
  }
  // 'already_revoked'/'not_found' on the OLD key does not undo the new
  // mint above — the new key is real and usable either way, and a
  // double-revoke attempt is reported but non-fatal (idempotent revoke).

  return { ok: true };
}

/**
 * Revoke, tiered (UX note #5): 'withdraw' stops future fetches without
 * touching the record; 'tombstone'/'destroy' both map onto the existing
 * `revokeMintedKey` soft-tombstone (mark the record revoked + crypto-erase
 * the grant's wrapped key material) — there is no harder-destroy primitive
 * in this codebase yet (see the #2242 PR description's own note on a
 * deferred harder tier), so 'destroy' is currently identical to
 * 'tombstone' beyond its copy. Flagged as a DECISION FOR RYAN in the PR
 * description rather than silently treated as fully implemented.
 */
async function executeRevoke(card: OperatorApprovalCard): Promise<VaultExecutionResult> {
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
    await revokeStaticSecretGrant(record.field, record.requestedBy);
    return { ok: true };
  }

  const outcome = await revokeMintedKey({ did, revokedBy: card.operatorDid });
  if (outcome.status === 'not_found') {
    return { ok: false, error: `vault:revoke — no minted key found for did '${did}'` };
  }
  if (outcome.status === 'revoked') {
    emitRevokedEvents(outcome.record, card.operatorDid);
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
 */
export async function executeVaultApproval(card: OperatorApprovalCard): Promise<VaultExecutionResult> {
  try {
    switch (card.kind) {
      case 'vault:mint':
        return await executeMint(card);
      case 'vault:grant':
        return await executeGrant(card);
      case 'vault:rotate':
        return await executeRotate(card);
      case 'vault:revoke':
        return await executeRevoke(card);
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
