import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { migrateCustody } from '@/src/lib/vault/migrate-custody';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

interface MigrateCustodyBody {
  dryRun?: unknown;
  limit?: unknown;
}

/**
 * POST /api/vault/migrate-custody — batch-migrate `node-sealed` (v1) vault
 * fields to `delegation-grant` (v2) custody (#1537).
 *
 * Admin-only. Wraps {@link migrateCustody}: enumerates v1 fields and, on a
 * real run, upgrades them through the same per-field path as
 * `POST /api/vault/upgrade-custody` — verifying each field still unseals
 * before moving to the next, and aborting on the first failure with per-field
 * results so an operator knows precisely where it stopped.
 *
 * A real run also refuses to start if a canary field does not come back
 * readable, or if a `vault_grant_requests` row has been pending suspiciously
 * long — both catch a Tier 1 owner agent that is not actually running before
 * a whole batch of credentials goes offline at once. See migrate-custody.ts
 * for the full reasoning.
 *
 * Body:
 *   dryRun (boolean, default true) — report what would change, mutate
 *     nothing. Mutating is opt-in: a caller must explicitly pass `false`.
 *   limit (number, optional) — cap how many v1 fields this call processes;
 *     omit to process every remaining v1 field. Each call is a single
 *     request/response with no background job, so an operator migrating a
 *     large vault should pass a small limit and call again rather than expect
 *     one call to walk the entire set.
 *
 * No plaintext is logged or ever appears in the response — only field names,
 * grant ids, and error strings.
 */
export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: MigrateCustodyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Default true: mutating vault custody is opt-in, never the default of an
  // ambiguous or empty body.
  const dryRun = body?.dryRun !== false;

  let limit: number | undefined;
  if (body?.limit !== undefined) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit <= 0) {
      return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 });
    }
    limit = body.limit;
  }

  try {
    const report = await migrateCustody({ dryRun, limit });

    log.info(
      {
        dryRun,
        limit: limit ?? null,
        totalV1Fields: report.totalV1Fields,
        candidateCount: report.candidateCount,
        processed: report.results.length,
        aborted: report.aborted,
      },
      'Vault migrate-custody run complete',
    );

    return NextResponse.json(report);
  } catch (error) {
    log.error({ err: String(error) }, 'Vault migrate-custody error');
    return toVaultErrorResponse(error, 'Failed to run vault custody migration', 500);
  }
}
