/**
 * Cron runner (#2550): the engine behind the `prod-kernel-cron` /
 * `dev-kernel-cron` pm2 apps (entry point: `./scheduler.ts`).
 *
 * Once a minute it checks each manifest job's schedule (UTC) and, for the ones
 * that are due, calls the route on localhost with
 * `Authorization: Bearer $CRON_SECRET`. Guarantees:
 *
 *   - A job with `noOverlap` never runs concurrently with itself: a tick that
 *     fires while the previous run is still in flight is skipped and logged.
 *   - Exactly one structured JSON log line per run (job, status, duration).
 *     The secret is never logged: it only ever appears in the request header,
 *     and error strings are scrubbed of it before being logged or persisted.
 *   - The outcome of every run is persisted to the shared state file
 *     (`./state.ts`) so `GET /api/admin/cron-status` can show last run and
 *     outcome per job.
 *
 * This file must stay free of Next.js / kernel-alias imports: the scheduler
 * runs under plain `node --import tsx`, outside the Next build.
 */
import { cronMatches, parseCronExpression, type ParsedCron } from './cron-expression';
import { cronJobName, type CronJob, type CronManifest } from './schedule';
import {
  emptyJobState,
  resolveCronStatePath,
  writeCronState,
  type CronJobState,
  type CronStateFile,
} from './state';

export type RunStatus = 'success' | 'failure' | 'skipped';

export interface CronLogLine {
  level: 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

export interface RunnerOptions {
  manifest: CronManifest;
  /** Loopback base URL of the app, e.g. `http://127.0.0.1:7000`. */
  baseUrl: string;
  secret: string;
  statePath: string;
  /** Abort a single route call after this long (the run is logged as a failure). */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: CronLogLine) => void;
  writeState?: (path: string, state: CronStateFile) => void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;
const MINUTE_MS = 60_000;

/** Default sink: one JSON object per line on stdout (stderr for warn/error), picked up by pm2 logs. */
export function jsonLineLog(line: CronLogLine): void {
  const out = `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`;
  (line.level === 'info' ? process.stdout : process.stderr).write(out);
}

function scrub(message: string, secret: string): string {
  return secret ? message.split(secret).join('[redacted]') : message;
}

function describeError(err: unknown, secret: string): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  const message = err instanceof Error ? err.message : String(err);
  return scrub(message, secret).slice(0, 200);
}

interface CompiledJob {
  job: CronJob;
  name: string;
  cron: ParsedCron;
}

export class CronRunner {
  private readonly jobs: CompiledJob[];
  private readonly inFlight = new Map<string, number>();
  private readonly state: CronStateFile;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (line: CronLogLine) => void;
  private readonly writeState: (path: string, state: CronStateFile) => void;
  private lastTickMinute = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: RunnerOptions) {
    // Parse every schedule up front: a bad expression must crash the process at
    // boot (pm2 shows it), not silently never fire.
    this.jobs = opts.manifest.jobs.map((job) => ({
      job,
      name: cronJobName(job),
      cron: parseCronExpression(job.schedule),
    }));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? jsonLineLog;
    this.writeState = opts.writeState ?? writeCronState;
    this.state = {
      version: 1,
      app: opts.manifest.app,
      schedulerStartedAt: this.now().toISOString(),
      jobs: Object.fromEntries(this.jobs.map((j) => [j.name, emptyJobState()])),
    };
  }

  /** Start every job that is due at `date` (truncated to the minute, UTC). Resolves when they all finish. */
  async tick(date: Date): Promise<void> {
    const minute = Math.floor(date.getTime() / MINUTE_MS);
    if (minute <= this.lastTickMinute) return; // a timer that fired twice for one minute
    this.lastTickMinute = minute;
    const due = this.jobs.filter((j) => cronMatches(j.cron, date));
    await Promise.all(due.map((j) => this.runJob(j.job)));
  }

  /** Run one job now (used by `tick`, and directly by tests). */
  async runJob(job: CronJob): Promise<RunStatus> {
    const name = cronJobName(job);

    if (job.noOverlap && (this.inFlight.get(name) ?? 0) > 0) {
      this.recordSkip(name);
      this.log({ level: 'warn', event: 'cron.run', job: name, status: 'skipped', reason: 'overlap' });
      return 'skipped';
    }

    this.inFlight.set(name, (this.inFlight.get(name) ?? 0) + 1);
    const startedAt = this.now();
    const t0 = performance.now();
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      httpStatus = await this.call(job);
    } catch (err) {
      error = describeError(err, this.opts.secret);
    } finally {
      this.inFlight.set(name, (this.inFlight.get(name) ?? 1) - 1);
    }

    const durationMs = Math.round(performance.now() - t0);
    const ok = error === null && httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    const status: RunStatus = ok ? 'success' : 'failure';
    this.recordRun(name, { startedAt, status, httpStatus, durationMs, error });
    this.log({
      level: ok ? 'info' : 'error',
      event: 'cron.run',
      job: name,
      status,
      httpStatus,
      durationMs,
      ...(error ? { error } : {}),
    });
    return status;
  }

  private async call(job: CronJob): Promise<number> {
    const response = await this.fetchImpl(new URL(job.path, this.opts.baseUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.opts.secret}` },
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    // Drain the body so the connection is released; its content is not logged.
    await response.arrayBuffer();
    return response.status;
  }

  private jobState(name: string): CronJobState {
    this.state.jobs[name] ??= emptyJobState();
    return this.state.jobs[name];
  }

  private recordSkip(name: string): void {
    const s = this.jobState(name);
    s.lastSkippedAt = this.now().toISOString();
    s.skippedTicks += 1;
    this.persist();
  }

  private recordRun(
    name: string,
    run: {
      startedAt: Date;
      status: RunStatus;
      httpStatus: number | null;
      durationMs: number;
      error: string | null;
    },
  ): void {
    const s = this.jobState(name);
    s.lastStartedAt = run.startedAt.toISOString();
    s.lastOutcome = run.status === 'success' ? 'success' : 'failure';
    s.lastHttpStatus = run.httpStatus;
    s.lastDurationMs = run.durationMs;
    s.lastError = run.error;
    this.persist();
  }

  private persist(): void {
    try {
      this.writeState(this.opts.statePath, this.state);
    } catch (err) {
      // State is observability only — never let it take the scheduler down.
      this.log({
        level: 'warn',
        event: 'cron.state-write-failed',
        error: describeError(err, this.opts.secret),
      });
    }
  }
}

/**
 * Drive `runner.tick` once per UTC minute until the returned `stop()` is
 * called. Overlap protection lives in the runner, so a slow job never delays
 * the next tick.
 */
export function startTicker(runner: CronRunner, now: () => number = Date.now): { stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const arm = () => {
    // +50ms past the boundary so the timer can never fire in the previous minute.
    const delay = MINUTE_MS - (now() % MINUTE_MS) + 50;
    timer = setTimeout(() => {
      if (stopped) return;
      void runner.tick(new Date(now()));
      arm();
    }, delay);
  };
  arm();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export interface SchedulerConfig {
  baseUrl: string;
  secret: string;
  statePath: string;
  requestTimeoutMs: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Build the scheduler config from the process environment. Throws (with a
 * message that never contains the secret) when it is unusable, so pm2 shows a
 * crash-loop instead of a scheduler that silently does nothing.
 */
export function resolveSchedulerConfig(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): SchedulerConfig {
  const secret = env.CRON_SECRET;
  if (!secret) {
    throw new Error('CRON_SECRET is not set — the cron scheduler cannot authenticate to the routes');
  }

  const baseUrl = env.CRON_BASE_URL?.trim() || `http://127.0.0.1:${env.PORT || 3000}`;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('CRON_BASE_URL is not a valid URL');
  }
  // The bearer secret must never leave the box.
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`CRON_BASE_URL must be a loopback address (got host "${parsed.hostname}")`);
  }

  const timeout = Number(env.CRON_REQUEST_TIMEOUT_MS);
  return {
    baseUrl: parsed.origin,
    secret,
    statePath: resolveCronStatePath(env, cwd),
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

/** Wire config + manifest into a running scheduler. Returns a `stop()` for graceful shutdown. */
export function startScheduler(
  manifest: CronManifest,
  env: NodeJS.ProcessEnv = process.env,
): { stop: () => void } {
  const config = resolveSchedulerConfig(env);
  const runner = new CronRunner({ manifest, ...config });
  jsonLineLog({
    level: 'info',
    event: 'cron.scheduler-started',
    app: manifest.app,
    jobs: manifest.jobs.length,
    baseUrl: config.baseUrl,
  });
  return startTicker(runner);
}
