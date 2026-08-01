import { NextResponse } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { listRenewableGrants } from '@/src/lib/vault';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/** Lookahead used when the caller does not pass `withinDays`. */
const DEFAULT_WITHIN_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * GET /api/vault/grants/renewable — the owner agent's renewal worklist.
 *
 * Admin-only. The counterpart to `/api/vault/grants/pending`: that endpoint
 * covers fields the node has just sealed and cannot yet read, this one covers
 * fields the node could read before and can no longer — a grant that expired,
 * was revoked, or is about to lapse.
 *
 * Each row carries the owner envelope (#1521) for that field, so the owner can
 * recover the field key with `ownerXPriv`, mint a fresh grant, and POST it to
 * `/api/vault/delegation/grant` with no `requestId`. Nothing here is sensitive
 * to anyone else: the wrapped key opens only under `ownerXPriv`, the same
 * reasoning that lets the pending endpoint return `wrappedFieldKey`.
 *
 * `?withinDays=N` widens or narrows the lookahead for grants that have not
 * expired yet (default 7). Grants with no active row at all are always listed,
 * since the node is already locked out of those.
 */
export async function GET(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const raw = new URL(request.url).searchParams.get('withinDays');
    const parsed = raw === null ? DEFAULT_WITHIN_DAYS : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return NextResponse.json(
        { error: 'withinDays must be a non-negative number' },
        { status: 400 },
      );
    }

    const identity = getNodeSigningIdentity();
    const grants = await listRenewableGrants({
      nodeDid: identity.senderDid,
      withinMs: parsed * MS_PER_DAY,
    });

    return NextResponse.json({
      nodeDid: identity.senderDid,
      withinDays: parsed,
      grants,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Vault grants/renewable error');
    return toVaultErrorResponse(error, 'Failed to fetch renewable grants', 500);
  }
}
