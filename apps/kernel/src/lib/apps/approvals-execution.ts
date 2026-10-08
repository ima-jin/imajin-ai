/**
 * `apps` proposal execution bridge (#2375) — the `apps.provision`
 * counterpart to `../vault/approvals-execution.ts` (#2247) and
 * `../access/approvals-execution.ts` (#2252). Ruled by Ryan (#2082,
 * carried forward into #2375): provisioning creates a repo and an
 * identity, so it is an OPERATOR-AUTHORITY proposal on the same
 * countersign rail every other high-stakes mechanical action rides —
 * `POST /api/apps/provision` only ever stages a `pending` proposal; this
 * module is what turns the operator's countersigned 'approve' decision
 * into the actual repo/mint/register/claim-code pipeline.
 *
 * Reuses `resolveVaultAuthorization` unchanged (per its own docs'
 * precedent for `access`, a second, non-vault consumer): apps:provision
 * requires a genuine operator countersignature on every decision,
 * unconditionally — never gated by the generic, opt-in
 * `OPERATOR_COUNTERSIGN_REQUIRED` flag alone.
 */
import { createLogger } from '@imajin/logger';
import type { OperatorApprovalCard } from '../notify/operator-approvals-service';
import { resolveVaultAuthorization } from '../vault/authorization';
import { runAppProvision, type AppProvisionOutcome } from './provision';
import { parseManifestDeclarations } from './declarations-approval';

const log = createLogger('kernel:apps:approvals-execution');

/** The open-vocabulary source this kind is filed under (#2152). */
export const APPS_SOURCE = 'apps';
export const APPS_PROVISION_KIND = 'apps:provision';

export interface AppsExecutionData {
  repoUrl: string;
  appDid: string;
  secretsSet: string[];
  /**
   * Plaintext one-time app-signing-key claim code (#2411) — surfaced in
   * the decision route's response EXACTLY ONCE, same posture as #2252's
   * `AccessExecutionData.bearer`. Never persisted anywhere past this
   * single response.
   */
  claimCode: string;
}

export type AppsExecutionResult =
  | { ok: true; data: AppsExecutionData }
  | { ok: false; error: string };

function requireString(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readAttestationTypes(detail: Record<string, unknown> | null): string[] {
  const value = detail?.attestationTypes;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Execute the pipeline behind an approved `apps:provision` proposal.
 * Called by the decision route immediately after `decideOperatorApproval`
 * records `decision: 'approve'`. Never throws — every outcome is
 * `{ ok, error? }` or `{ ok, data }`, matching `executeVaultApproval`'s /
 * `executeAccessApproval`'s own contract so the decision route can treat
 * every source uniformly.
 *
 * Fails closed at the same choke point as vault/access:
 * `resolveVaultAuthorization` returning `null` (no genuine, already-
 * verified operator countersignature on the decision) refuses execution
 * outright, before the provisioning pipeline is even invoked.
 */
export async function executeAppsProvisionApproval(card: OperatorApprovalCard): Promise<AppsExecutionResult> {
  const authorizedBy = resolveVaultAuthorization(card);
  if (!authorizedBy) {
    log.warn({ proposalId: card.proposalId, kind: card.kind }, 'Apps proposal execution refused — missing or unverified operator countersignature');
    return { ok: false, error: `${card.kind} requires a countersigned operator decision` };
  }

  if (card.kind !== APPS_PROVISION_KIND) {
    return { ok: false, error: `Unrecognized apps proposal kind '${card.kind}'` };
  }

  const slug = requireString(card.detail, 'slug');
  const displayName = requireString(card.detail, 'displayName');
  if (!slug || !displayName) {
    return { ok: false, error: 'apps:provision proposal is missing slug/displayName' };
  }
  const template = requireString(card.detail, 'template') ?? undefined;
  const attestationTypes = readAttestationTypes(card.detail);

  try {
    // #2663: the providesScopes/dependsOn list the operator saw on the card — the
    // pipeline registers exactly this and refuses a manifest that has drifted from it.
    const approvedDeclarations = parseManifestDeclarations(card.detail?.manifestDeclarations);
    const outcome: AppProvisionOutcome = await runAppProvision({ slug, displayName, template, attestationTypes, approvedDeclarations });
    if (outcome.status === 'failed') {
      return { ok: false, error: `apps.provision failed at step '${outcome.failedStep}': ${outcome.error}` };
    }
    return {
      ok: true,
      data: {
        repoUrl: outcome.repoUrl,
        appDid: outcome.appDid,
        secretsSet: outcome.secretsSet,
        claimCode: outcome.claimCode,
      },
    };
  } catch (err) {
    log.error({ err: String(err), proposalId: card.proposalId, slug }, 'Apps proposal execution failed');
    return { ok: false, error: 'Apps proposal execution failed' };
  }
}
