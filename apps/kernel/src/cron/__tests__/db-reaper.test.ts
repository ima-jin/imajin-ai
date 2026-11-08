import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REAP_STUCK_BACKENDS_SQL, STUCK_BACKEND_PREDICATE,
  reapStuckBackends, reaperThreshold, startDatabaseReaper,
} from '../db-reaper';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

afterEach(() => { vi.useRealTimers(); });

describe('stuck backend selection', () => {
  it('selects exactly the own-role, own-database old active ClientRead client', () => {
    const fixture = new DatabaseSync(':memory:');
    // SQLite timestamps are epoch seconds. Only interval syntax and the SQL
    // current_user keyword need dialect adaptation; the predicate is unchanged.
    fixture.function('now', () => 1000);
    fixture.function('current_database', () => 'imajin_prod');
    fixture.function('pg_backend_pid', () => 99);
    fixture.exec(`CREATE TABLE pg_stat_activity (
      pid INTEGER, datname TEXT, usename TEXT, backend_type TEXT,
      state TEXT, wait_event TEXT, state_change INTEGER
    )`);
    const base = [1, 'imajin_prod', 'app', 'client backend', 'active', 'ClientRead', 699];
    const rows = [
      base,
      [2, ...base.slice(1, 6), 700], // exactly threshold is not older
      [3, ...base.slice(1, 6), 701],
      [4, 'imajin_dev', ...base.slice(2)],
      [5, base[1], 'another_role', ...base.slice(3)],
      [6, ...base.slice(1, 3), 'walsender', ...base.slice(4)],
      [7, ...base.slice(1, 4), 'idle', ...base.slice(5)],
      [8, ...base.slice(1, 4), 'idle in transaction', ...base.slice(5)],
      [9, ...base.slice(1, 5), 'ClientWrite', base[6]],
      [10, ...base.slice(1, 5), null, base[6]],
      [99, ...base.slice(1)],
      [11, ...base.slice(1, 6), null],
    ];
    const insert = fixture.prepare('INSERT INTO pg_stat_activity VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(...row as (string | number | null)[]);
    const predicate = STUCK_BACKEND_PREDICATE
      .replaceAll("interval '1 second'", '1')
      .replaceAll('current_user', "'app'");
    expect(fixture.prepare(`SELECT pid FROM pg_stat_activity WHERE ${predicate}`).all({ $1: 300 }))
      .toEqual([{ pid: 1 }]);
    expect(REAP_STUCK_BACKENDS_SQL).toContain(`WHERE ${STUCK_BACKEND_PREDICATE}`);
    expect(REAP_STUCK_BACKENDS_SQL).toContain('pg_terminate_backend(pid)');
    fixture.close();
  });

  it('defaults to five minutes and accepts a configured threshold', () => {
    expect(reaperThreshold({})).toBe(300);
    expect(reaperThreshold({ DB_REAPER_THRESHOLD_SECONDS: '600' })).toBe(600);
  });

  it.each(['0', '-1', '1.5', '', 'NaN', 'Infinity', '9007199254740992'])('rejects threshold %s', value => {
    expect(() => reaperThreshold({ DB_REAPER_THRESHOLD_SECONDS: value })).toThrow('positive integer');
  });
});

it('destroys a stalled reaper socket after ten seconds and retries next minute', async () => {
  vi.useFakeTimers();
  const client = { unsafe: vi.fn(() => new Promise<[]>(() => {})), end: vi.fn().mockResolvedValue(undefined) };
  const log = vi.fn();
  const create = vi.fn(() => client);
  const handle = startDatabaseReaper({ DATABASE_URL: 'postgres://localhost/fixture' }, log, create);
  await vi.advanceTimersByTimeAsync(70_000);
  expect(client.end).toHaveBeenCalledWith({ timeout: 1 });
  expect(log).toHaveBeenCalledWith({ level: 'error', event: 'db.reaper-failed' });
  await vi.advanceTimersByTimeAsync(50_000);
  expect(create).toHaveBeenCalledTimes(2);
  handle.stop();
});

it('logs each termination outcome without raw SQL literals, at most 80 characters', async () => {
  const unsafe = vi.fn().mockResolvedValue([
    { pid: 1, age_seconds: '301', query: "SELECT 'private-value'", application_name: 'kernel', terminated: true },
    { pid: 2, age_seconds: 400, query: '/* private-value */ SELECT 1', application_name: 'other', terminated: false },
  ]);
  const log = vi.fn();
  await reapStuckBackends({ unsafe, end: vi.fn() }, 300, log);
  expect(unsafe).toHaveBeenCalledWith(REAP_STUCK_BACKENDS_SQL, [300]);
  expect(log.mock.calls.map(([entry]) => entry)).toEqual([
    { level: 'warn', event: 'db.reaper', pid: 1, age_seconds: 301, query_prefix: 'SELECT', application_name: 'kernel', terminated: true },
    { level: 'error', event: 'db.reaper', pid: 2, age_seconds: 400, query_prefix: '[redacted]', application_name: 'other', terminated: false },
  ]);
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
  for (const [entry] of log.mock.calls) expect(entry.query_prefix.length).toBeLessThanOrEqual(80);
});

it('runs once per minute, skips overlap, closes its own socket, and stops', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const client = { unsafe: vi.fn().mockResolvedValue([]), end: vi.fn(() => new Promise<void>(resolve => { release = resolve; })) };
  const create = vi.fn(() => client);
  const handle = startDatabaseReaper({ DATABASE_URL: 'postgres://localhost/fixture' }, vi.fn(), create);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(create).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(create).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.end).toHaveBeenCalledWith({ timeout: 1 });
  handle.stop();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(create).toHaveBeenCalledOnce();
});

it('logs generic failures and retries next minute even if closing fails', async () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const client = { unsafe: vi.fn().mockRejectedValue(new Error('private-value')), end: vi.fn().mockRejectedValue(new Error('private-value')) };
  const handle = startDatabaseReaper({ DATABASE_URL: 'postgres://localhost/fixture' }, log, () => client);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(client.unsafe).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith({ level: 'error', event: 'db.reaper-failed' });
  expect(log).toHaveBeenCalledWith({ level: 'error', event: 'db.reaper-close-failed' });
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
  handle.stop();
});

it('refuses missing database configuration', () => {
  expect(() => startDatabaseReaper({}, vi.fn())).toThrow('DATABASE_URL');
});
