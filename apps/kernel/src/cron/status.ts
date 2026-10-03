/**
 * Builds the payload for `GET /api/admin/cron-status` (#2550): per job, the
 * schedule, last run time and outcome, and whether the job is overdue — so a
 * dead scheduler or a stuck job is visible instead of silent.
 */
import { parseCronExpression, previousFire } from './cron-expression';
import { cronJobName, type CronManifest } from './schedule';
import { emptyJobState, readCronState, type CronJobState } from './state';

/** A job is only "stale" once its latest scheduled tick is this far in the past without a run. */
export const STALE_GRACE_MS = 2 * 60_000;

export interface CronJobStatus extends CronJobState {
  job: string;
  path: string;
  schedule: string;
  /** Most recent scheduled tick at or before now (ISO), or null if none within a year. */
  lastScheduledAt: string | null;
  /** True when a scheduled tick has passed (plus grace) with no run started since. */
  stale: boolean;
}

export interface CronStatus {
  app: string;
  /** False when the scheduler has never written state (not started, or wrong state path). */
  schedulerSeen: boolean;
  schedulerStartedAt: string | null;
  now: string;
  jobs: CronJobStatus[];
}

export function buildCronStatus(
  manifest: CronManifest,
  statePath: string,
  now: Date = new Date(),
): CronStatus {
  const file = readCronState(statePath);

  const jobs = manifest.jobs.map((job): CronJobStatus => {
    const name = cronJobName(job);
    const state: CronJobState = { ...emptyJobState(), ...file?.jobs[name] };
    const scheduled = previousFire(parseCronExpression(job.schedule), now);
    const startedMs = state.lastStartedAt ? Date.parse(state.lastStartedAt) : Number.NEGATIVE_INFINITY;
    const overdue =
      scheduled !== null &&
      now.getTime() - scheduled.getTime() > STALE_GRACE_MS &&
      startedMs < scheduled.getTime();
    return {
      job: name,
      path: job.path,
      schedule: job.schedule,
      ...state,
      lastScheduledAt: scheduled ? scheduled.toISOString() : null,
      stale: overdue,
    };
  });

  return {
    app: manifest.app,
    schedulerSeen: file !== null,
    schedulerStartedAt: file?.schedulerStartedAt ?? null,
    now: now.toISOString(),
    jobs,
  };
}
