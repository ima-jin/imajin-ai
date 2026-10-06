/**
 * Last-run state for scheduled jobs (#2550).
 *
 * The scheduler process is the only writer; the kernel's
 * `GET /api/admin/cron-status` endpoint is a reader. They share a small JSON
 * file rather than a database table so this needs no schema migration.
 *
 * The default location is `<cwd>/.cron-state.json`: pm2 starts the kernel and
 * the scheduler with the same per-environment `cwd` (`.../<env>/imajin-ai/apps/kernel`),
 * so dev and prod can never read each other's state without any extra
 * config. `CRON_STATE_PATH` overrides it (tests, unusual layouts).
 *
 * Only job names, timestamps, HTTP status codes and short error strings are
 * stored — never the CRON_SECRET or response bodies.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type CronOutcome = 'success' | 'failure';

export interface CronJobState {
  /** ISO time the most recent completed run started. */
  lastStartedAt: string | null;
  /** Outcome of the most recent completed run. */
  lastOutcome: CronOutcome | null;
  /** HTTP status the route answered with, or null on a transport error. */
  lastHttpStatus: number | null;
  lastDurationMs: number | null;
  /** Short transport-level error message when the call itself failed. */
  lastError: string | null;
  /** ISO time of the most recent tick skipped because a run was still in flight. */
  lastSkippedAt: string | null;
  /** How many ticks have been skipped for overlap since the scheduler started. */
  skippedTicks: number;
}

export interface CronStateFile {
  version: 1;
  app: string;
  /** ISO time the scheduler process that wrote this file started. */
  schedulerStartedAt: string;
  jobs: Record<string, CronJobState>;
}

export function emptyJobState(): CronJobState {
  return {
    lastStartedAt: null,
    lastOutcome: null,
    lastHttpStatus: null,
    lastDurationMs: null,
    lastError: null,
    lastSkippedAt: null,
    skippedTicks: 0,
  };
}

export function resolveCronStatePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const override = env.CRON_STATE_PATH?.trim();
  return override || join(cwd, '.cron-state.json');
}

/** Read the state file; null when it is missing, unreadable or not our format. */
export function readCronState(path: string): CronStateFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CronStateFile> | null;
    if (parsed?.version !== 1 || typeof parsed.jobs !== 'object' || parsed.jobs === null) return null;
    return parsed as CronStateFile;
  } catch {
    return null;
  }
}

/** Atomically replace the state file (write temp + rename). */
export function writeCronState(path: string, state: CronStateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
