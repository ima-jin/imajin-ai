import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/src/cron/auth';
import { KERNEL_CRON_MANIFEST } from '@/src/cron/schedule';
import { resolveCronStatePath } from '@/src/cron/state';
import { buildCronStatus } from '@/src/cron/status';

/** Reads live scheduler state per request; must never be statically prerendered. */
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/cron-status — last run time and outcome for every scheduled
 * kernel job (#2550), as recorded by the `*-kernel-cron` scheduler process.
 *
 * Authenticated with the same fail-closed bearer gate as the cron routes
 * themselves (503 if the vault-held cron secret is unavailable, 401 on a wrong
 * bearer). The secret is a vault grant, never an env var or a file on the host
 * (#2241), so there is no `$CRON_SECRET` to paste into a curl: the caller is the
 * `*-kernel-cron` scheduler (or an agent holding a grant for the
 * `kernel.cron-secret` purpose).
 *
 * A job with `stale: true` has had a scheduled tick pass with no run; if every
 * job is stale (or `schedulerSeen` is false) the scheduler process is down.
 */
export async function GET(request: Request) {
  const denied = await requireCronAuth(request);
  if (denied) return denied;

  return NextResponse.json(buildCronStatus(KERNEL_CRON_MANIFEST, resolveCronStatePath()));
}
