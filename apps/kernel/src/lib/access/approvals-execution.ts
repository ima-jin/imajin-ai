/**
 * Access proposal execution bridge (#2252) — the `access` counterpart to
 * `../vault/approvals-execution.ts` (#2247). Approving a `source: 'access'`
 * proposal on the existing /jin operator-approvals rail (#2059/#2152) IS
 * the signing event for the delegate-grant bearer's mint: this module is
 * what turns that witnessed tap into the actual mint, called by the
 * decision route right after a successful 'approve' on an access-sourced
 * proposal.
 *
 * Reuses `resolveVaultAuthorization` unchanged (the #2084 signing-roles
 * gate — three signatures, three roles: agent wishes, operator
 * countersigns the decision, node executes+witnesses) rather than forking
 * a byte-identical copy under a different name; the function itself has no
 * "vault" in its logic, only in the file it was born in (#2247's PR
 * predates this second consumer).
 */
import { createLogger } from '@imajin/logger';
import type { OperatorApprovalCard } from '../notify/operator-approvals-service';
import { resolveVaultAuthorization, type VaultAuthorization } from '../vault/authorization';
import { getNodeSigningIdentity } from '../vault/sealing';
import {
  getDelegateGrantRequestById,
  markDelegateGrantRequestExpired,
  issueDelegateGrantBearer,
} from './delegate-grant';

const log = createLogger('kernel');

export const ACCESS_BEARER_GRANT_KIND = 'access:bearer-grant';

export type { VaultAuthorization as AccessAuthorization };

export interface AccessExecutionData {
  /** The plaintext bearer — surfaced in the decision route's response EXACTLY ONCE. */
  bearer: string;
  bearerId: string;
  expiresAt: string;
  hardCapAt: string;
}

export type AccessExecutionResult =
  | { ok: true; data: AccessExecutionData }
  | { ok: false; error: string };

function requireString(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Execute the mint behind an approved `access:bearer-grant` proposal.
 * Called by the decision route immediately after `decideOperatorApproval`
 * records `decision: 'approve'`. Never throws — every outcome is
 * `{ ok, error? }` or `{ ok, data }`, matching `executeVaultApproval`'s own
 * contract so the decision route can treat both sources uniformly.
 *
 * Fails closed, same choke point as vault: `resolveVaultAuthorization`
 * returning `null` (no genuine, already-verified operator countersignature
 * on the decision) refuses the mint outright, before the knock request is
 * even loaded.
 */
export async function executeAccessApproval(card: OperatorApprovalCard): Promise<AccessExecutionResult> {
  const authorizedBy = resolveVaultAuthorization(card);
  if (!authorizedBy) {
    log.warn({ proposalId: card.proposalId, kind: card.kind }, 'Access proposal execution refused — missing or unverified operator countersignature');
    return { ok: false, error: `${card.kind} requires a countersigned operator decision` };
  }

  if (card.kind !== ACCESS_BEARER_GRANT_KIND) {
    return { ok: false, error: `Unrecognized access proposal kind '${card.kind}'` };
  }

  const requestId = requireString(card.detail, 'requestId');
  if (!requestId) {
    return { ok: false, error: 'access:bearer-grant proposal is missing requestId' };
  }

  try {
    const request = await getDelegateGrantRequestById(requestId);
    if (!request) {
      return { ok: false, error: `access:bearer-grant — no delegate-grant request found for '${requestId}'` };
    }
    if (request.status !== 'pending') {
      return { ok: false, error: `Delegate-grant request is not pending (status: ${request.status})` };
    }
    if (request.expiresAt.getTime() <= Date.now()) {
      await markDelegateGrantRequestExpired(requestId);
      return { ok: false, error: 'Delegate-grant knock has expired (24h pending window) — ask the client to knock again' };
    }

    const nodeDid = getNodeSigningIdentity().senderDid;
    const issued = await issueDelegateGrantBearer({ request, issuedBy: nodeDid, authorizedBy });
    return {
      ok: true,
      data: { bearer: issued.bearer, bearerId: issued.bearerId, expiresAt: issued.expiresAt, hardCapAt: issued.hardCapAt },
    };
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId, requestId }, 'Access proposal execution failed');
    return { ok: false, error: 'Access proposal execution failed' };
  }
}
