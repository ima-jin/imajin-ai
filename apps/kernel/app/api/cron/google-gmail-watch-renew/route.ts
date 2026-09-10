import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { listActiveGrantOwners } from '@/src/lib/google/connector';
import { listWatchExpirations, watch } from '@/src/lib/google/gmail';

const log = createLogger('kernel');

/** This route reads live DB state per invocation and must never be statically prerendered. */
export const dynamic = 'force-dynamic';

/** Renew a watch when it expires within this window (Google's own TTL is ~7 days). */
const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

interface RenewResult {
  ownerDid: string;
}

interface RenewFailure {
  ownerDid: string;
  error: string;
}

/**
 * GET /api/cron/google-gmail-watch-renew — Gmail `users.watch` renewal sweep (#2144).
 *
 * Google expires a Gmail push subscription after ~7 days regardless of
 * activity. Scheduled daily (see vercel.json) — well inside the renewal
 * window — so a watch is renewed long before it lapses into "no more
 * pushes, and nothing tells you why". Protected by
 * `Authorization: Bearer {CRON_SECRET}`, same pattern as every other cron
 * route (see `quickbooks-reconcile/route.ts`).
 *
 * Enumerates every DID with an active `google:gmail:read` grant — not just
 * DIDs with a prior watch row — so a grant that was never watched (e.g. the
 * owner granted the scope but no tool called `google_gmail_watch` yet) still
 * gets picked up.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const owners = await listActiveGrantOwners('google:gmail:read');
    const expirations = new Map(
      (await listWatchExpirations()).map((row) => [row.ownerDid, row.expiration]),
    );

    const now = Date.now();
    const dueForRenewal = owners.filter((ownerDid) => {
      const expiration = expirations.get(ownerDid);
      return !expiration || expiration.getTime() - now <= RENEWAL_WINDOW_MS;
    });

    const results: RenewResult[] = [];
    const failures: RenewFailure[] = [];

    for (const ownerDid of dueForRenewal) {
      try {
        await watch(ownerDid);
        results.push({ ownerDid });
      } catch (err) {
        log.error({ err: String(err), ownerDid }, 'Gmail watch renewal: owner failed');
        failures.push({ ownerDid, error: String(err) });
      }
    }

    log.info(
      { owners: owners.length, dueForRenewal: dueForRenewal.length, renewed: results.length, failed: failures.length },
      'Gmail watch renewal sweep complete',
    );

    return NextResponse.json({ ok: true, owners: owners.length, renewed: results.length, results, failures });
  } catch (error) {
    log.error({ err: String(error) }, 'Gmail watch renewal sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
