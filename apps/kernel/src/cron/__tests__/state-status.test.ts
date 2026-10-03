import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyJobState, readCronState, resolveCronStatePath, writeCronState, type CronStateFile } from '../state';
import { STALE_GRACE_MS, buildCronStatus } from '../status';
import type { CronManifest } from '../schedule';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cron-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const manifest: CronManifest = {
  app: 'kernel',
  jobs: [
    { path: '/api/cron/every-ten', schedule: '*/10 * * * *', noOverlap: true },
    { path: '/api/cron/daily', schedule: '0 2 * * *', noOverlap: true },
  ],
};

function stateFile(jobs: CronStateFile['jobs']): CronStateFile {
  return { version: 1, app: 'kernel', schedulerStartedAt: '2026-10-03T00:00:00.000Z', jobs };
}

describe('state file', () => {
  it('resolves to <cwd>/.cron-state.json unless CRON_STATE_PATH overrides it', () => {
    expect(resolveCronStatePath({}, '/srv/kernel')).toBe('/srv/kernel/.cron-state.json');
    expect(resolveCronStatePath({ CRON_STATE_PATH: '  ' }, '/srv/kernel')).toBe('/srv/kernel/.cron-state.json');
    expect(resolveCronStatePath({ CRON_STATE_PATH: '/var/x.json' }, '/srv/kernel')).toBe('/var/x.json');
  });

  it('round-trips through an atomic write, creating parent directories and leaving no temp file', () => {
    const path = join(dir, 'nested', 'state.json');
    const state = stateFile({ daily: { ...emptyJobState(), lastOutcome: 'success', lastHttpStatus: 200 } });

    writeCronState(path, state);

    expect(readCronState(path)).toEqual(state);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json']);
    expect(statSync(path).mode & 0o077).toBe(0); // owner-only
  });

  it('returns null for a missing, corrupt or foreign-format file', () => {
    expect(readCronState(join(dir, 'missing.json'))).toBeNull();

    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    expect(readCronState(corrupt)).toBeNull();

    const foreign = join(dir, 'foreign.json');
    writeFileSync(foreign, JSON.stringify({ version: 2, jobs: {} }));
    expect(readCronState(foreign)).toBeNull();

    const nullJobs = join(dir, 'null-jobs.json');
    writeFileSync(nullJobs, JSON.stringify({ version: 1, jobs: null }));
    expect(readCronState(nullJobs)).toBeNull();

    const literalNull = join(dir, 'null.json');
    writeFileSync(literalNull, 'null');
    expect(readCronState(literalNull)).toBeNull();
    expect(existsSync(literalNull)).toBe(true);
  });
});

describe('buildCronStatus', () => {
  const now = new Date('2026-10-03T12:25:00.000Z'); // last */10 tick was 12:20, last daily was 02:00

  it('reports schedulerSeen=false and every job never-run when there is no state file', () => {
    const status = buildCronStatus(manifest, join(dir, 'none.json'), now);

    expect(status).toMatchObject({ app: 'kernel', schedulerSeen: false, schedulerStartedAt: null, now: now.toISOString() });
    expect(status.jobs.map((j) => j.job)).toEqual(['every-ten', 'daily']);
    expect(status.jobs[0]).toMatchObject({
      path: '/api/cron/every-ten',
      schedule: '*/10 * * * *',
      lastStartedAt: null,
      lastOutcome: null,
      lastScheduledAt: '2026-10-03T12:20:00.000Z',
      stale: true, // a tick has come and gone with nothing run
    });
    expect(status.jobs[1].lastScheduledAt).toBe('2026-10-03T02:00:00.000Z');
  });

  it('reports last run time and outcome per job from the state file', () => {
    const path = join(dir, 'state.json');
    writeCronState(
      path,
      stateFile({
        'every-ten': {
          ...emptyJobState(),
          lastStartedAt: '2026-10-03T12:20:01.000Z',
          lastOutcome: 'success',
          lastHttpStatus: 200,
          lastDurationMs: 340,
        },
        daily: {
          ...emptyJobState(),
          lastStartedAt: '2026-10-03T02:00:02.000Z',
          lastOutcome: 'failure',
          lastHttpStatus: 500,
          lastDurationMs: 12,
          skippedTicks: 2,
          lastSkippedAt: '2026-10-03T02:01:00.000Z',
        },
      }),
    );

    const status = buildCronStatus(manifest, path, now);

    expect(status.schedulerSeen).toBe(true);
    expect(status.schedulerStartedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(status.jobs[0]).toMatchObject({
      job: 'every-ten',
      lastStartedAt: '2026-10-03T12:20:01.000Z',
      lastOutcome: 'success',
      lastHttpStatus: 200,
      lastDurationMs: 340,
      stale: false,
    });
    expect(status.jobs[1]).toMatchObject({
      job: 'daily',
      lastOutcome: 'failure',
      lastHttpStatus: 500,
      skippedTicks: 2,
      stale: false, // a failing job is not stale: it ran, the outcome says it failed
    });
  });

  it('flags a job stale when a scheduled tick passed (plus grace) with no run since', () => {
    const path = join(dir, 'state.json');
    writeCronState(
      path,
      stateFile({
        'every-ten': { ...emptyJobState(), lastStartedAt: '2026-10-03T12:00:01.000Z', lastOutcome: 'success' },
      }),
    );

    const stale = buildCronStatus(manifest, path, now);
    expect(stale.jobs[0].stale).toBe(true); // 12:10 and 12:20 were missed
    expect(stale.jobs[1].stale).toBe(true); // never ran at all
  });

  it('does not flag a job stale inside the grace window after a tick', () => {
    const justAfterTick = new Date(new Date('2026-10-03T12:20:00.000Z').getTime() + STALE_GRACE_MS - 1000);
    const status = buildCronStatus(manifest, join(dir, 'none.json'), justAfterTick);
    expect(status.jobs[0].stale).toBe(false);
  });

  it('tolerates a state file that is missing a job (new manifest entry)', () => {
    const path = join(dir, 'state.json');
    writeCronState(path, stateFile({}));
    const status = buildCronStatus(manifest, path, now);
    expect(status.schedulerSeen).toBe(true);
    expect(status.jobs[0]).toMatchObject({ lastStartedAt: null, skippedTicks: 0 });
  });

  it('never reports stale and a null lastScheduledAt for a schedule that cannot fire', () => {
    const never: CronManifest = { app: 'kernel', jobs: [{ path: '/api/cron/never', schedule: '0 0 31 2 *', noOverlap: true }] };
    const status = buildCronStatus(never, join(dir, 'none.json'), now);
    expect(status.jobs[0]).toMatchObject({ lastScheduledAt: null, stale: false });
  });
});
