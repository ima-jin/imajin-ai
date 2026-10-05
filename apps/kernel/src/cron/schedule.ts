/**
 * Kernel cron manifest (#2550).
 *
 * The single source of truth for every scheduled job the kernel runs. We do
 * not deploy on Vercel, so the old `apps/kernel/vercel.json` `crons` block
 * never fired anything on the self-hosted pm2 boxes. The scheduler process
 * (`./scheduler.ts`, pm2 apps `prod-kernel-cron` / `dev-kernel-cron`) reads
 * this manifest and calls each route on localhost.
 *
 * The manifest is per-app: an app that leaves the kernel (#1981) brings its
 * own `src/cron/schedule.ts` exporting a `CronManifest` for its own routes,
 * and the scheduler is pointed at it. `scripts/ci-guard-cron-manifest.mjs`
 * fails CI when this list and `app/api/cron/<name>/route.ts` drift apart.
 *
 * Schedules are standard 5-field cron expressions evaluated in UTC (the same
 * timezone Vercel Cron used, so every job fires exactly when it used to be
 * declared to).
 *
 * NOTE: keep entries as plain object literals — the CI guard reads this file
 * as text, it does not import it.
 */

export interface CronJob {
  /** Route path served by the app, e.g. `/api/cron/usage-rollup`. Called with GET. */
  path: string;
  /** 5-field cron expression (minute hour day-of-month month day-of-week), UTC. */
  schedule: string;
  /**
   * When true, a tick that fires while the previous run of this job is still
   * in flight is skipped (and logged) instead of starting a second copy.
   */
  noOverlap: boolean;
}

export interface CronManifest {
  /** App directory name under `apps/`. */
  app: string;
  jobs: readonly CronJob[];
}

export const KERNEL_CRON_MANIFEST: CronManifest = {
  app: 'kernel',
  jobs: [
    { path: '/api/cron/vault-grant-expiry', schedule: '0 * * * *', noOverlap: true },
    { path: '/api/cron/quickbooks-reconcile', schedule: '0 */6 * * *', noOverlap: true },
    { path: '/api/cron/withdrawal-reconcile', schedule: '*/15 * * * *', noOverlap: true },
    { path: '/api/cron/attestation-cleanup', schedule: '0 0 * * *', noOverlap: true },
    { path: '/api/cron/event-subscription-cleanup', schedule: '0 1 * * *', noOverlap: true },
    { path: '/api/cron/claim-stub-expiry', schedule: '0 0 * * *', noOverlap: true },
    { path: '/api/cron/warp-run-watch', schedule: '*/10 * * * *', noOverlap: true },
    { path: '/api/cron/usage-rollup', schedule: '0 2 * * *', noOverlap: true },
    { path: '/api/cron/usage-billed-ingest', schedule: '0 2 * * *', noOverlap: true },
    { path: '/api/cron/google-gmail-watch-renew', schedule: '0 3 * * *', noOverlap: true },
  ],
};

const CRON_PATH_PREFIX = '/api/cron/';

/** Short job name used in logs and the status endpoint: the last path segment. */
export function cronJobName(job: Pick<CronJob, 'path'>): string {
  return job.path.startsWith(CRON_PATH_PREFIX) ? job.path.slice(CRON_PATH_PREFIX.length) : job.path;
}
