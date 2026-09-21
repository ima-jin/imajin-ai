import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { fetchGrantSecret, type GrantFetchOutcome } from '@/src/lib/vault';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/** HTTP status for every non-'ok' outcome `fetchGrantSecret` can return. */
function statusForOutcome(status: Exclude<GrantFetchOutcome['status'], 'ok'>): number {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      // Identical response shape for both: confirming a grantId exists but
      // belongs to someone else would let a caller enumerate grantIds it
      // cannot use.
      return 404;
    case 'consumed':
      return 410;
    case 'inactive':
    case 'expired':
    default:
      return 403;
  }
}

function errorForOutcome(status: Exclude<GrantFetchOutcome['status'], 'ok'>): string {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      return 'No delegation grant found for this id';
    case 'consumed':
      return 'This one-time grant has already been fetched';
    case 'inactive':
      return 'This grant is no longer active';
    case 'expired':
      return 'This grant has expired';
    default:
      return 'Unable to fetch this grant';
  }
}

/** Fire-and-forget audit publish — never fails the fetch request itself. */
function auditFetch(params: {
  grantId: string;
  field: string;
  granteeDid: string;
  purpose: string | null;
  oneTime: boolean;
  outcome: GrantFetchOutcome['status'] | 'error';
}): void {
  publish('vault.delegation.fetched', {
    issuer: params.granteeDid,
    subject: params.granteeDid,
    scope: 'vault',
    payload: {
      grantId: params.grantId,
      field: params.field,
      granteeDid: params.granteeDid,
      purpose: params.purpose,
      oneTime: params.oneTime,
      outcome: params.outcome,
      context_id: params.grantId,
      context_type: 'vault.delegation',
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err), grantId: params.grantId }, 'Bus publish error for vault.delegation.fetched');
  });
}

/**
 * POST /api/vault/delegation/grants/{grantId}/fetch — an authenticated agent
 * DID fetches the sealed value behind a specific delegation grant issued to
 * it (#2231 remote human -> agent credential handoff).
 *
 * Session/bearer-authenticated as the agent DID itself (`requireAuth`), NOT
 * `requireAdmin`. The kernel validates, in order: the grant exists, it was
 * granted to THIS caller, it is `active`, it has not expired, and — for
 * `oneTime` grants — it has not already been consumed. Every attempt,
 * successful or refused, is audited via the `vault.delegation.fetched` bus
 * event (never carries the secret value itself).
 *
 * A `oneTime` grant is consumed by its first successful fetch; every fetch
 * after that returns 410 Gone.
 */
export async function POST(request: Request, props: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const granteeDid = authResult.identity.id;

  try {
    const outcome = await fetchGrantSecret({ grantId, granteeDid });

    if (outcome.status !== 'ok') {
      // No grant row to report `field`/`purpose`/`oneTime` from when the
      // grantId itself is unrecognized or belongs to someone else.
      auditFetch({
        grantId,
        field: '',
        granteeDid,
        purpose: null,
        oneTime: false,
        outcome: outcome.status,
      });
      return NextResponse.json(
        { error: errorForOutcome(outcome.status) },
        { status: statusForOutcome(outcome.status) },
      );
    }

    auditFetch({
      grantId,
      field: outcome.grant.field,
      granteeDid,
      purpose: outcome.grant.purpose,
      oneTime: outcome.grant.oneTime,
      outcome: 'ok',
    });

    return NextResponse.json({
      ok: true,
      field: outcome.grant.field,
      value: outcome.value,
      purpose: outcome.grant.purpose,
      oneTime: outcome.grant.oneTime,
      expiresAt: outcome.grant.expiresAt ? outcome.grant.expiresAt.toISOString() : null,
    });
  } catch (error) {
    auditFetch({
      grantId,
      field: '',
      granteeDid,
      purpose: null,
      oneTime: false,
      outcome: 'error',
    });
    log.error({ err: String(error), grantId, granteeDid }, 'Vault delegation grant fetch error');
    return toVaultErrorResponse(error, 'Failed to fetch delegation grant', 500);
  }
}
