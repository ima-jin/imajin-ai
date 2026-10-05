import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CronRunner,
  DEFAULT_REQUEST_TIMEOUT_MS,
  jsonLineLog,
  resolveSchedulerConfig,
  startScheduler,
  startTicker,
  type CronLogLine,
} from '../runner';
import type { CronJob, CronManifest } from '../schedule';
import type { CronStateFile } from '../state';

const SECRET = 'unit-test-cron-secret';
const BASE_URL = 'http://127.0.0.1:7000';
const VAULT_ENV = {
  KERNEL_CRON_VAULT_BOOTSTRAP_DID: 'did:imajin:kernel-cron-test',
  KERNEL_CRON_VAULT_BOOTSTRAP_PRIVATE_KEY: 'bootstrap-private-key-for-tests',
};

function vaultDeps() {
  const used = vi.fn();
  const loadFromVault = vi.fn(async () => ({
    values: { CRON_SECRET: SECRET },
    dids: {},
    degraded: [],
    acks: { CRON_SECRET: { used, failed: vi.fn(), discarded: vi.fn() } },
  }));
  return { used, loadFromVault, deps: { loadFromVault, sleep: async () => undefined } };
}

const HOURLY: CronJob = { path: '/api/cron/hourly', schedule: '0 * * * *', noOverlap: true };
const EVERY_MINUTE: CronJob = { path: '/api/cron/every-minute', schedule: '* * * * *', noOverlap: true };
const OVERLAPPING_OK: CronJob = { path: '/api/cron/parallel', schedule: '* * * * *', noOverlap: false };

function manifestOf(...jobs: CronJob[]): CronManifest {
  return { app: 'test', jobs };
}

interface Deferred {
  promise: Promise<Response>;
  resolve: (status?: number) => void;
  reject: (err: Error) => void;
}

function deferredResponse(): Deferred {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<Response>((res, rej) => {
    resolve = (status = 200) => res(new Response('{}', { status }));
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRunner(
  manifest: CronManifest,
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof CronRunner>[0]> = {},
) {
  const logs: CronLogLine[] = [];
  const states: CronStateFile[] = [];
  const runner = new CronRunner({
    manifest,
    baseUrl: BASE_URL,
    secret: SECRET,
    statePath: '/nonexistent/state.json',
    fetchImpl,
    log: (line) => logs.push(line),
    writeState: (_path, state) => states.push(structuredClone(state)),
    ...extra,
  });
  return { runner, logs, states };
}

const okFetch = () => vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));

describe('CronRunner.runJob', () => {
  it('calls the route on the base URL with the bearer secret and logs one structured line', async () => {
    const fetchImpl = okFetch();
    const { runner, logs } = makeRunner(manifestOf(HOURLY), fetchImpl);

    const status = await runner.runJob(HOURLY);

    expect(status).toBe('success');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:7000/api/cron/hourly');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'info', event: 'cron.run', job: 'hourly', status: 'success', httpStatus: 200 });
    expect(typeof logs[0].durationMs).toBe('number');
  });

  it('records a non-2xx response as a failure', async () => {
    const { runner, logs, states } = makeRunner(
      manifestOf(HOURLY),
      vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 })),
    );

    expect(await runner.runJob(HOURLY)).toBe('failure');
    expect(logs[0]).toMatchObject({ level: 'error', status: 'failure', httpStatus: 503 });
    expect(states.at(-1)?.jobs.hourly).toMatchObject({ lastOutcome: 'failure', lastHttpStatus: 503, lastError: null });
  });

  it('records a transport error as a failure and scrubs the secret from the error text', async () => {
    const { runner, logs, states } = makeRunner(
      manifestOf(HOURLY),
      vi.fn<typeof fetch>(async () => {
        throw new Error(`connect ECONNREFUSED while sending Bearer ${SECRET}`);
      }),
    );

    expect(await runner.runJob(HOURLY)).toBe('failure');
    const logged = JSON.stringify(logs) + JSON.stringify(states);
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).not.toContain(SECRET);
    expect(logs[0]).toMatchObject({ httpStatus: null });
  });

  it('describes a non-Error rejection and a timeout', async () => {
    const stringThrow = makeRunner(
      manifestOf(HOURLY),
      vi.fn<typeof fetch>(() => Promise.reject('plain string')),
    );
    await stringThrow.runner.runJob(HOURLY);
    expect(stringThrow.logs[0].error).toBe('plain string');

    const timeout = makeRunner(
      manifestOf(HOURLY),
      vi.fn<typeof fetch>(() => Promise.reject(new DOMException('aborted', 'TimeoutError'))),
    );
    await timeout.runner.runJob(HOURLY);
    expect(timeout.logs[0].error).toBe('timeout');
  });

  it('passes an abort signal driven by requestTimeoutMs', async () => {
    const fetchImpl = okFetch();
    const { runner } = makeRunner(manifestOf(HOURLY), fetchImpl, { requestTimeoutMs: 5 });
    await runner.runJob(HOURLY);
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('persists last run time, outcome, status and duration to state', async () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    const { runner, states } = makeRunner(manifestOf(HOURLY), okFetch(), { now: () => now });

    await runner.runJob(HOURLY);

    const state = states.at(-1)!;
    expect(state).toMatchObject({ version: 1, app: 'test', schedulerStartedAt: now.toISOString() });
    expect(state.jobs.hourly).toMatchObject({
      lastStartedAt: now.toISOString(),
      lastOutcome: 'success',
      lastHttpStatus: 200,
      lastError: null,
    });
    expect(state.jobs.hourly.lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps running when the state file cannot be written, and says so', async () => {
    const { runner, logs } = makeRunner(manifestOf(HOURLY), okFetch(), {
      writeState: () => {
        throw new Error(`EACCES writing state near ${SECRET}`);
      },
    });

    expect(await runner.runJob(HOURLY)).toBe('success');
    const warn = logs.find((l) => l.event === 'cron.state-write-failed');
    expect(warn?.level).toBe('warn');
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });
});

describe('no overlap', () => {
  it('skips (and logs) a tick that fires while the previous run of the same job is in flight', async () => {
    const first = deferredResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    const { runner, logs, states } = makeRunner(manifestOf(EVERY_MINUTE), fetchImpl);

    const running = runner.runJob(EVERY_MINUTE);
    const skipped = await runner.runJob(EVERY_MINUTE);

    expect(skipped).toBe('skipped');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not doubled
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn', event: 'cron.run', job: 'every-minute', status: 'skipped', reason: 'overlap' });
    expect(states.at(-1)?.jobs['every-minute']).toMatchObject({ skippedTicks: 1 });
    expect(states.at(-1)?.jobs['every-minute'].lastSkippedAt).not.toBeNull();

    first.resolve();
    expect(await running).toBe('success');
    expect(logs).toHaveLength(2);

    // Once the first run is done the job is free to run again.
    const second = await runner.runJob(EVERY_MINUTE);
    expect(second).toBe('success');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the skip never called fetch
  });

  it('frees the job even when the in-flight run fails', async () => {
    const first = deferredResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    const { runner } = makeRunner(manifestOf(EVERY_MINUTE), fetchImpl);

    const running = runner.runJob(EVERY_MINUTE);
    first.reject(new Error('boom'));
    expect(await running).toBe('failure');
    expect(await runner.runJob(EVERY_MINUTE)).toBe('success');
  });

  it('does not block different jobs while one is running', async () => {
    const slow = deferredResponse();
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      String(input).endsWith('/hourly') ? slow.promise : Promise.resolve(new Response('{}', { status: 200 })),
    );
    const { runner } = makeRunner(manifestOf(HOURLY, EVERY_MINUTE), fetchImpl);

    const running = runner.runJob(HOURLY);
    expect(await runner.runJob(EVERY_MINUTE)).toBe('success');
    slow.resolve();
    await running;
  });

  it('allows concurrent runs when the job opts out of noOverlap', async () => {
    const first = deferredResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    const { runner } = makeRunner(manifestOf(OVERLAPPING_OK), fetchImpl);

    const running = runner.runJob(OVERLAPPING_OK);
    expect(await runner.runJob(OVERLAPPING_OK)).toBe('success');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    first.resolve();
    await running;
  });

  it('tick() skips a slow job on the next minute but still runs other due jobs', async () => {
    const slow = deferredResponse();
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      String(input).endsWith('/every-minute') ? slow.promise : Promise.resolve(new Response('{}', { status: 200 })),
    );
    const other: CronJob = { path: '/api/cron/other', schedule: '* * * * *', noOverlap: true };
    const { runner, logs } = makeRunner(manifestOf(EVERY_MINUTE, other), fetchImpl);

    const firstTick = runner.tick(new Date('2026-10-03T12:00:00Z'));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the fast job finish
    await runner.tick(new Date('2026-10-03T12:01:00Z'));

    const everyMinuteCalls = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/every-minute'));
    expect(everyMinuteCalls).toHaveLength(1); // the 12:01 tick was skipped, not doubled
    expect(logs.filter((l) => l.status === 'skipped')).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/other'))).toHaveLength(2);

    slow.resolve();
    await firstTick;
  });
});

describe('CronRunner.tick', () => {
  it('runs only the jobs whose schedule matches the minute (UTC)', async () => {
    const fetchImpl = okFetch();
    const { runner } = makeRunner(manifestOf(HOURLY, EVERY_MINUTE), fetchImpl);

    await runner.tick(new Date('2026-10-03T14:00:00Z'));
    expect(fetchImpl.mock.calls.map(([u]) => String(u))).toEqual([
      `${BASE_URL}/api/cron/hourly`,
      `${BASE_URL}/api/cron/every-minute`,
    ]);

    fetchImpl.mockClear();
    await runner.tick(new Date('2026-10-03T14:01:00Z'));
    expect(fetchImpl.mock.calls.map(([u]) => String(u))).toEqual([`${BASE_URL}/api/cron/every-minute`]);
  });

  it('ignores a second tick for a minute it has already handled', async () => {
    const fetchImpl = okFetch();
    const { runner } = makeRunner(manifestOf(EVERY_MINUTE), fetchImpl);

    await runner.tick(new Date('2026-10-03T14:00:00Z'));
    await runner.tick(new Date('2026-10-03T14:00:30Z'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to construct with an invalid schedule', () => {
    const bad: CronJob = { path: '/api/cron/bad', schedule: 'not a cron', noOverlap: true };
    expect(() => makeRunner(manifestOf(bad), okFetch())).toThrow(/Invalid cron expression/);
  });
});

describe('startTicker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks once per minute boundary and stops when asked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T14:00:10Z'));
    const tick = vi.fn(async () => undefined);
    const ticker = startTicker({ tick } as unknown as CronRunner);

    await vi.advanceTimersByTimeAsync(50_000 + 100); // past 14:01:00
    expect(tick).toHaveBeenCalledTimes(1);
    expect((tick.mock.calls[0] as unknown as [Date])[0].toISOString().slice(0, 16)).toBe('2026-10-03T14:01');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);

    ticker.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('stop() before the first tick prevents any run', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);
    const ticker = startTicker({ tick } as unknown as CronRunner);
    ticker.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('resolveSchedulerConfig', () => {
  it('defaults to loopback on PORT (or 3000) and to <cwd>/.cron-state.json, with no secret in the config', () => {
    const withPort = resolveSchedulerConfig({ PORT: '7000' }, '/srv/kernel');
    expect(withPort).toEqual({
      baseUrl: 'http://127.0.0.1:7000',
      statePath: '/srv/kernel/.cron-state.json',
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    expect(resolveSchedulerConfig({}, '/srv/kernel').baseUrl).toBe('http://127.0.0.1:3000');
  });

  it('never takes a secret from the environment', () => {
    const config = resolveSchedulerConfig({ CRON_SECRET: SECRET });
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  it('honours CRON_BASE_URL, CRON_STATE_PATH and CRON_REQUEST_TIMEOUT_MS overrides', () => {
    const config = resolveSchedulerConfig({
      CRON_BASE_URL: 'http://localhost:3000/',
      CRON_STATE_PATH: '/var/lib/cron.json',
      CRON_REQUEST_TIMEOUT_MS: '1234',
    });
    expect(config).toMatchObject({ baseUrl: 'http://localhost:3000', statePath: '/var/lib/cron.json', requestTimeoutMs: 1234 });
  });

  it('ignores a nonsensical timeout', () => {
    const config = resolveSchedulerConfig({ CRON_REQUEST_TIMEOUT_MS: '-5' });
    expect(config.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('refuses a non-loopback base URL so the bearer secret never leaves the box', () => {
    expect(() => resolveSchedulerConfig({ CRON_BASE_URL: 'https://kernel.example.com' })).toThrow(/loopback/);
  });

  it('refuses an unparseable base URL', () => {
    expect(() => resolveSchedulerConfig({ CRON_BASE_URL: 'not a url' })).toThrow(/not a valid URL/);
  });
});

describe('logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('jsonLineLog writes one JSON line: info to stdout, warn/error to stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    jsonLineLog({ level: 'info', event: 'cron.run', job: 'a', status: 'success' });
    jsonLineLog({ level: 'error', event: 'cron.run', job: 'b', status: 'failure' });

    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(out.mock.calls[0][0]));
    expect(line).toMatchObject({ level: 'info', event: 'cron.run', job: 'a', status: 'success' });
    expect(typeof line.ts).toBe('string');
    expect(String(out.mock.calls[0][0]).endsWith('\n')).toBe(true);
  });

  it('startScheduler fetches the secret from the vault, logs a start line without it, and returns a stoppable handle', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { deps, loadFromVault } = vaultDeps();

    const handle = await startScheduler(
      manifestOf(HOURLY),
      { ...VAULT_ENV, PORT: '7000', CRON_STATE_PATH: '/srv/cron/state.json' },
      deps,
    );

    expect(loadFromVault).toHaveBeenCalledTimes(1);
    expect(loadFromVault.mock.calls[0][0]).toMatchObject({
      resolveGrantByPurpose: 'kernel.cron-secret',
      authServiceUrl: `${BASE_URL}/auth`,
      identity: { did: 'did:imajin:kernel-cron-test' },
    });
    expect(out).toHaveBeenCalledTimes(1);
    const text = String(out.mock.calls[0][0]);
    expect(JSON.parse(text)).toMatchObject({ event: 'cron.scheduler-started', app: 'test', jobs: 1, baseUrl: BASE_URL });
    expect(text).not.toContain(SECRET);
    handle.stop();
  });

  it('startScheduler rejects on a bad config instead of starting a dead scheduler', async () => {
    const { deps, loadFromVault } = vaultDeps();
    await expect(startScheduler(manifestOf(HOURLY), { ...VAULT_ENV, CRON_BASE_URL: 'https://example.com' }, deps)).rejects.toThrow(
      /loopback/,
    );
    expect(loadFromVault).not.toHaveBeenCalled();
  });

  it('startScheduler rejects with a vault-pointing error when the bootstrap identity is missing', async () => {
    const { deps } = vaultDeps();
    const failure = startScheduler(manifestOf(HOURLY), {}, deps);
    await expect(failure).rejects.toThrow(/KERNEL_CRON_VAULT_BOOTSTRAP_DID/);
    await expect(failure).rejects.not.toThrow(/set CRON_SECRET/);
  });
});

describe('vault grant ack (one deferred ack, on first accepted use)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function runOneTick(status: number) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T10:00:10.000Z'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stateDir = mkdtempSync(join(tmpdir(), 'cron-ack-'));
    const fetchMock = vi.fn(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const { deps, used } = vaultDeps();

    const handle = await startScheduler(
      manifestOf(EVERY_MINUTE),
      { ...VAULT_ENV, PORT: '7000', CRON_STATE_PATH: join(stateDir, 'state.json') },
      deps,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    handle.stop();
    rmSync(stateDir, { recursive: true, force: true });
    return { used, fetchMock };
  }

  it('sends the ack once the kernel accepts the secret, and presents the vault-sourced bearer', async () => {
    const { used, fetchMock } = await runOneTick(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(init.headers).toEqual({ authorization: `Bearer ${SECRET}` });
    expect(used).toHaveBeenCalledTimes(1);
    expect(used).toHaveBeenCalledWith('first-request');
  });

  it('does not ack when the kernel rejects the secret (401) or reports it unconfigured (503)', async () => {
    expect((await runOneTick(401)).used).not.toHaveBeenCalled();
    expect((await runOneTick(503)).used).not.toHaveBeenCalled();
  });
});
