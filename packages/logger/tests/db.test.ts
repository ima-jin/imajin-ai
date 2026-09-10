import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLogSink } from '../src/sink';

// Fake tagged-template `sql` + call recorder, following the established
// @imajin/db mock pattern documented in packages/bus/AGENTS.md.
const { calls, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve([]);
  });
  return { calls, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

// db.ts registers itself as the active sink as an import side effect.
import { dbSink } from '../src/db';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// The very first write of each log source (request/app) always triggers an
// opportunistic `SELECT registry.cleanup_old_logs(...)` right after its
// insert (lastRequestCleanupAt/lastAppCleanupAt start at 0), so tests must
// pick out the INSERT call by content rather than assume it's the only or
// last call recorded.
function lastInsert() {
  return [...calls].reverse().find((c) => c.text.includes('INSERT INTO registry.logs'))!;
}

describe('@imajin/logger/db sink', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('registers itself as the active log sink on import', () => {
    expect(getLogSink()).toBe(dbSink);
  });

  it('writeRequestLog inserts into registry.logs and derives an info level for 2xx', async () => {
    dbSink.writeRequestLog?.({
      service: 'kernel',
      method: 'GET',
      path: '/foo',
      status: 200,
      durationMs: 12,
      correlationId: 'cor_abc',
      ip: '127.0.0.1',
    });
    await flush();

    const insert = lastInsert();
    expect(insert.text).toContain("'request'");
    expect(insert.values).toEqual(
      expect.arrayContaining(['kernel', 'info', 'GET', '/foo', 200, 12, 'cor_abc', '127.0.0.1'])
    );
  });

  it('derives error/warn levels from 5xx/4xx status codes', async () => {
    dbSink.writeRequestLog?.({
      service: 'kernel',
      method: 'POST',
      path: '/bar',
      status: 500,
      durationMs: 1,
      correlationId: 'cor_1',
      ip: '10.0.0.1',
    });
    await flush();
    expect(lastInsert().values).toContain('error');

    dbSink.writeRequestLog?.({
      service: 'kernel',
      method: 'POST',
      path: '/bar',
      status: 404,
      durationMs: 1,
      correlationId: 'cor_2',
      ip: '10.0.0.1',
    });
    await flush();
    expect(lastInsert().values).toContain('warn');
  });

  it('uses the provided errorMessage as the message when present', async () => {
    dbSink.writeRequestLog?.({
      service: 'kernel',
      method: 'GET',
      path: '/boom',
      status: 500,
      durationMs: 3,
      correlationId: 'cor_3',
      ip: '10.0.0.1',
      errorMessage: 'kaboom',
    });
    await flush();
    expect(lastInsert().values).toContain('kaboom');
  });

  it('falls back to a generated message when no errorMessage is given', async () => {
    dbSink.writeRequestLog?.({
      service: 'kernel',
      method: 'GET',
      path: '/quiet',
      status: 200,
      durationMs: 3,
      correlationId: 'cor_4',
      ip: '10.0.0.1',
    });
    await flush();
    expect(lastInsert().values).toContain('GET /quiet → 200');
  });

  it('writeAppLog inserts into registry.logs with source=app', async () => {
    dbSink.writeAppLog?.({
      service: 'auth',
      level: 'error',
      message: 'something broke',
      correlationId: 'cor_9',
      did: 'did:imajin:x',
      metadata: { foo: 'bar' },
    });
    await flush();

    const insert = lastInsert();
    expect(insert.text).toContain("'app'");
    expect(insert.values).toEqual(
      expect.arrayContaining(['auth', 'error', 'something broke', 'cor_9', 'did:imajin:x'])
    );
  });

  it('serializes metadata as JSON, and omits it when absent', async () => {
    dbSink.writeAppLog?.({ service: 'auth', level: 'warn', message: 'no metadata here' });
    await flush();
    expect(lastInsert().values).toContain(null);

    dbSink.writeAppLog?.({ service: 'auth', level: 'warn', message: 'with metadata', metadata: { a: 1 } });
    await flush();
    expect(lastInsert().values).toContain(JSON.stringify({ a: 1 }));
  });

  it('never throws synchronously even when the sql call rejects', async () => {
    fakeSql.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    expect(() =>
      dbSink.writeAppLog?.({ service: 'auth', level: 'error', message: 'x' })
    ).not.toThrow();
    await flush();
  });
});
