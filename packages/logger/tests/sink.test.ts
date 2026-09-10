import { describe, it, expect, afterEach } from 'vitest';
import { registerLogSink, getLogSink, resetLogSink } from '../src/sink';
import type { LogSink } from '../src/sink';

describe('log sink registry', () => {
  afterEach(() => {
    resetLogSink();
  });

  it('has no sink registered by default', () => {
    expect(getLogSink()).toBeNull();
  });

  it('returns the sink registered via registerLogSink', () => {
    const sink: LogSink = { writeRequestLog: () => {} };
    registerLogSink(sink);
    expect(getLogSink()).toBe(sink);
  });

  it('last registration wins when called multiple times', () => {
    const first: LogSink = { writeRequestLog: () => {} };
    const second: LogSink = { writeAppLog: () => {} };
    registerLogSink(first);
    registerLogSink(second);
    expect(getLogSink()).toBe(second);
  });

  it('resetLogSink clears the active sink', () => {
    registerLogSink({ writeRequestLog: () => {} });
    resetLogSink();
    expect(getLogSink()).toBeNull();
  });
});
