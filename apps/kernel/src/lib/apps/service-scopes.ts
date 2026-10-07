/**
 * Per-app operator-approved service scopes (#2711) — the `apps:service-scopes`
 * counterpart to `apps:provision` (#2375) on the same operator-approvals
 * countersign rail.
 *
 * #1803 fences a session-less service token to `requestedScopes ∩
 * serviceEligibleScopes()`. That fence is global and fail-closed, so a partner
 * app that legitimately needs e.g. `identity:write` had no way in. This module
 * is the way in WITHOUT widening the global fence and WITHOUT letting an app
 * grant itself anything through its own `requestedScopes`:
 *
 *   - an app owner (or the operator) PROPOSES `{appDid, action, scopes[]}` —
 *     `POST /api/apps/service-scopes` only ever stages a `pending` card;
 *   - the operator countersigns it on /jin — `executeAppsServiceScopesApproval`
 *     refuses to touch the app row unless `resolveVaultAuthorization` finds a
 *     genuine operator countersignature, unconditionally (never gated by the
 *     opt-in `OPERATOR_COUNTERSIGN_REQUIRED` flag);
 *   - the approved set is stored on `registry.apps.approved_service_scopes`
 *     (with the approval id + timestamp) and the mint becomes
 *     `requestedScopes ∩ (serviceEligible ∪ approved)`.
 *
 * Revocation is the same rail with `action: 'revoke'`: it removes scopes from
 * the approved set, so the next minted token drops them.
 *
 * Consumers that add a new operator-approved service scope (e.g. #2642's
 * `settle`) only need the scope to exist in the vocabulary and to be proposed
 * through this module — there is no second store.
 */
import { and, eq, sql } from 'drizzle-orm';
import { validateScopes, serviceEligibleScopes } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, registryApps, operatorApprovals, type OperatorApprovalRow } from '@/src/db';
import type { OperatorApprovalCard } from '../notify/operator-approvals-service';
import { resolveVaultAuthorization } from '../vault/authorization';
import { APPS_SOURCE } from './approvals-execution';
import { APPS_SERVICE_SCOPES_KIND } from './service-scopes-kind';

const log = createLogger('kernel:apps:service-scopes');

export type ServiceScopesAction = 'grant' | 'revoke';

export const MAX_SERVICE_SCOPES_PER_PROPOSAL = 20;

export interface ServiceScopesDetail {
  appDid: string;
  action: ServiceScopesAction;
  scopes: string[];
}

export type ServiceScopesExecutionResult =
  | { ok: true; data: { appDid: string; action: ServiceScopesAction; approvedServiceScopes: string[] } }
  | { ok: false; error: string };

/** Sorted, de-duplicated copy — the canonical order stored and displayed. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort((a, b) => a.localeCompare(b));
}

/**
 * The scopes a session-less service token may carry for an app (#2711):
 * `requestedScopes ∩ (serviceEligibleScopes() ∪ approved)`, with the requested
 * set first clamped to the scope vocabulary. A scope present ONLY in
 * `requestedScopes` never survives; neither does an approved scope the app
 * did not request.
 */
export function mintableServiceScopes(
  requestedScopes: readonly string[] | null | undefined,
  approvedServiceScopes: readonly string[] | null | undefined,
): string[] {
  const { valid } = validateScopes([...(requestedScopes ?? [])]);
  const allowed = new Set<string>([...serviceEligibleScopes(), ...(approvedServiceScopes ?? [])]);
  return valid.filter((scope) => allowed.has(scope));
}

/** Read an operator-approved scope list off an untrusted `detail` / DB value. */
export function parseScopeList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0)) return null;
  return normalizeScopes(value);
}

/** Read the proposal `detail` the operator signed. `null` for anything that isn't exactly the expected shape. */
export function parseServiceScopesDetail(detail: Record<string, unknown> | null): ServiceScopesDetail | null {
  const appDid = detail?.appDid;
  const action = detail?.action;
  const scopes = parseScopeList(detail?.scopes);
  if (typeof appDid !== 'string' || appDid.length === 0) return null;
  if (action !== 'grant' && action !== 'revoke') return null;
  if (!scopes || scopes.length === 0 || scopes.length > MAX_SERVICE_SCOPES_PER_PROPOSAL) return null;
  return { appDid, action, scopes };
}

/** Find an already-pending proposal for the same app + action + scope set, so a repeat POST reuses the card. */
export async function findPendingServiceScopesProposal(
  detail: ServiceScopesDetail,
): Promise<OperatorApprovalRow | undefined> {
  const rows = await db
    .select()
    .from(operatorApprovals)
    .where(
      and(
        eq(operatorApprovals.source, APPS_SOURCE),
        eq(operatorApprovals.kind, APPS_SERVICE_SCOPES_KIND),
        eq(operatorApprovals.status, 'pending'),
        sql`${operatorApprovals.detail}->>'appDid' = ${detail.appDid}`,
      ),
    );
  const wanted = JSON.stringify(detail.scopes);
  return rows.find((row) => {
    const parsed = parseServiceScopesDetail(row.detail as Record<string, unknown> | null);
    return parsed?.action === detail.action && JSON.stringify(parsed.scopes) === wanted;
  });
}

/**
 * Execute an approved `apps:service-scopes` proposal: add (grant) or remove
 * (revoke) the scopes on the app's approved set. Never throws.
 *
 * Fails closed at the same choke point as vault/access/apps:provision:
 * `resolveVaultAuthorization` returning `null` (no genuine, already-verified
 * operator countersignature on the decision) refuses outright, before the
 * app row is read.
 */
export async function executeAppsServiceScopesApproval(card: OperatorApprovalCard): Promise<ServiceScopesExecutionResult> {
  const authorizedBy = resolveVaultAuthorization(card);
  if (!authorizedBy) {
    log.warn({ proposalId: card.proposalId, kind: card.kind }, 'Service-scopes execution refused — missing or unverified operator countersignature');
    return { ok: false, error: `${card.kind} requires a countersigned operator decision` };
  }
  if (card.kind !== APPS_SERVICE_SCOPES_KIND) {
    return { ok: false, error: `Unrecognized apps proposal kind '${card.kind}'` };
  }

  const detail = parseServiceScopesDetail(card.detail);
  if (!detail) {
    return { ok: false, error: `${APPS_SERVICE_SCOPES_KIND} proposal is missing appDid/action/scopes` };
  }
  // Only vocabulary scopes can be granted; a revoke may remove anything.
  if (detail.action === 'grant' && validateScopes(detail.scopes).invalid.length > 0) {
    return { ok: false, error: `${APPS_SERVICE_SCOPES_KIND} proposal names a scope outside the vocabulary` };
  }

  try {
    const [app] = await db
      .select({ status: registryApps.status, approved: registryApps.approvedServiceScopes })
      .from(registryApps)
      .where(eq(registryApps.appDid, detail.appDid));
    if (!app) return { ok: false, error: `Unknown app DID '${detail.appDid}'` };
    if (detail.action === 'grant' && app.status !== 'active') {
      return { ok: false, error: `App '${detail.appDid}' is not active` };
    }

    const current = parseScopeList(app.approved) ?? [];
    const approvedServiceScopes =
      detail.action === 'grant'
        ? normalizeScopes([...current, ...detail.scopes])
        : current.filter((scope) => !detail.scopes.includes(scope));

    await db
      .update(registryApps)
      .set({
        approvedServiceScopes,
        serviceScopesApprovalId: authorizedBy.approvalId,
        serviceScopesApprovedAt: new Date(authorizedBy.decidedAt),
      })
      .where(eq(registryApps.appDid, detail.appDid));

    log.info(
      { proposalId: card.proposalId, appDid: detail.appDid, action: detail.action, scopes: detail.scopes, operatorDid: authorizedBy.operatorDid },
      'Applied operator-approved service scopes',
    );
    return { ok: true, data: { appDid: detail.appDid, action: detail.action, approvedServiceScopes } };
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId, appDid: detail.appDid }, 'Service-scopes execution failed');
    return { ok: false, error: 'Service-scopes execution failed' };
  }
}
