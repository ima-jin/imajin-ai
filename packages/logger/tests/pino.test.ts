import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/adapters/pino';
import { registerLogSink, resetLogSink } from '../src/sink';
import type { AppLogEntry } from '../src/sink';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of ['LOG_DB_TRANSPORT', 'ENABLE_APP_LOG']) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

describe('createLogger (pino adapter)', () => {
  let writeAppLog: ReturnType<typeof vi.fn<[AppLogEntry], void>>;

  beforeEach(() => {
    writeAppLog = vi.fn();
    registerLogSink({ writeAppLog });
  });

  afterEach(() => {
    resetLogSink();
    resetEnv();
  });

  it('does not persist to the sink when no DB-transport flag is set', () => {
    delete process.env.LOG_DB_TRANSPORT;
    delete process.env.ENABLE_APP_LOG;
    const log = createLogger('svc');

    log.error({}, 'boom');

    expect(writeAppLog).not.toHaveBeenCalled();
  });

  it('persists warn/error but not info/debug once LOG_DB_TRANSPORT=true (default min level: warn)', () => {
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    log.debug({}, 'd');
    log.info({}, 'i');
    expect(writeAppLog).not.toHaveBeenCalled();

    log.warn({}, 'w');
    log.error({}, 'e');
    expect(writeAppLog).toHaveBeenCalledTimes(2);
  });

  it('also persists when ENABLE_APP_LOG=true (either flag enables it)', () => {
    process.env.ENABLE_APP_LOG = 'true';
    const log = createLogger('svc');

    log.error({}, 'e');

    expect(writeAppLog).toHaveBeenCalledTimes(1);
  });

  it('defaults service to "unknown" when the context has none', () => {
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    log.error({}, 'e');

    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ service: 'unknown' }));
  });

  it('passes service/correlationId/did/method/path through, message, and level', () => {
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    log.warn(
      { service: 'kernel', correlationId: 'cor_1', did: 'did:imajin:x', method: 'GET', path: '/p' },
      'a warning'
    );

    expect(writeAppLog).toHaveBeenCalledWith({
      service: 'kernel',
      level: 'warn',
      message: 'a warning',
      correlationId: 'cor_1',
      did: 'did:imajin:x',
      method: 'GET',
      path: '/p',
      errorMessage: undefined,
      metadata: undefined,
    });
  });

  it('extracts errorMessage from an Error instance under `err`', () => {
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    log.error({ err: new Error('kaboom') }, 'failed');

    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: 'kaboom' }));
  });

  it('extracts errorMessage from a string under `error`', () => {
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    log.error({ error: 'raw string error' }, 'failed');

    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: 'raw string error' }));
  });

  it('JSON-stringifies non-Error, non-string error-shaped values', () => {
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    log.error({ err: { code: 42 } }, 'failed');

    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: JSON.stringify({ code: 42 }) }));
  });

  it('collects remaining context fields into metadata, and omits it when empty', () => {
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    log.warn({ service: 'kernel', extra: 'field', another: 1 }, 'w');
    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: { extra: 'field', another: 1 } }));

    writeAppLog.mockClear();
    log.warn({ service: 'kernel' }, 'w2');
    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: undefined }));
  });

  it('child() still routes persistence through the sink (bindings affect stdout, not the persisted ctx)', () => {
    // persist() only reads the per-call `ctx` argument, not the child
    // instance's bound fields (pino applies those separately to the stdout
    // line) — this is pre-existing behavior, unchanged by #2143.
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc').child({ correlationId: 'cor_child' });

    log.error({}, 'nested');
    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ correlationId: undefined }));

    writeAppLog.mockClear();
    log.error({ correlationId: 'cor_explicit' }, 'nested with explicit ctx');
    expect(writeAppLog).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'cor_explicit' }));
  });

  it('does nothing when no sink is registered, even if persistence is enabled', () => {
    resetLogSink();
    process.env.LOG_DB_TRANSPORT = 'true';
    const log = createLogger('svc');

    expect(() => log.error({}, 'no sink registered')).not.toThrow();
  });
});
