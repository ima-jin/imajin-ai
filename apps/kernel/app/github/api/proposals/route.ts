import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { db, githubActionProposals } from '@/src/db';

export const dynamic = 'force-dynamic';

const log = createLogger('kernel:github:proposals');

// 'expired' is queryable but not shown by default — a lapsed approval window is
// history, not something awaiting the owner's attention (#1588).
const VALID_STATUSES = new Set(['pending', 'approved', 'done', 'denied', 'expired']);
const DEFAULT_STATUSES = ['pending', 'approved'] as const;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /github/api/proposals
 *
 * List action proposals for the signed-in identity.
 * Powers the /jin dashboard pending-proposals panel (#1429).
 *
 * Query params:
 *   ?status=pending,approved        — comma-separated; defaults to pending,approved
 *   ?limit=50                       — max rows returned; defaults to 50
 *
 * Returns: { proposals: GitHubActionProposal[] }
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get('status');
  const rawLimit  = url.searchParams.get('limit');

  // Parse and validate statuses.
  const statuses: string[] = rawStatus
    ? rawStatus.split(',').map((s) => s.trim()).filter((s) => VALID_STATUSES.has(s))
    : [...DEFAULT_STATUSES];

  if (statuses.length === 0) {
    return NextResponse.json(
      { error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` },
      { status: 400, headers: cors }
    );
  }

  const limit = Math.min(
    Number.isNaN(Number(rawLimit)) ? 50 : Math.max(1, Number(rawLimit)),
    200
  );

  try {
    const proposals = await db
      .select()
      .from(githubActionProposals)
      .where(
        and(
          eq(githubActionProposals.ownerDid, ownerDid),
          inArray(githubActionProposals.status, statuses),
        )
      )
      .orderBy(desc(githubActionProposals.createdAt))
      .limit(limit);

    return NextResponse.json({ proposals }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), ownerDid }, '[github/proposals] list failed');
    return NextResponse.json({ error: 'Failed to list proposals' }, { status: 500, headers: cors });
  }
}
