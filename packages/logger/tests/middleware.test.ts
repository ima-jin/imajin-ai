import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const fakeLog = {
  child: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
fakeLog.child.mockReturnValue(fakeLog);

vi.mock('../src/adapters/pino', () => ({
  createLogger: () => fakeLog,
}));

import { withLogger } from '../src/middleware';
import { registerLogSink, resetLogSink } from '../src/sink';
import type { RequestLogEntry } from '../src/sink';

const ORIGINAL_ENABLE_REQUEST_LOG = process.env.ENABLE_REQUEST_LOG;

function makeReq(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

describe('withLogger', () => {
  let writeRequestLog: ReturnType<typeof vi.fn<[RequestLogEntry], void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeLog.child.mockReturnValue(fakeLog);
    writeRequestLog = vi.fn();
    registerLogSink({ writeRequestLog });
  });

  afterEach(() => {
    resetLogSink();
    if (ORIGINAL_ENABLE_REQUEST_LOG === undefined) delete process.env.ENABLE_REQUEST_LOG;
    else process.env.ENABLE_REQUEST_LOG = ORIGINAL_ENABLE_REQUEST_LOG;
  });

  it('propagates an incoming X-Correlation-Id and sets it on the response', async () => {
    const handler = withLogger('kernel', async (_req, { correlationId }) => {
      return new Response(JSON.stringify({ correlationId }), { status: 200 });
    });

    const res = await handler(makeReq('https://kernel.test/api/x', { 'x-correlation-id': 'cor_fixed' }));

    expect(res.headers.get('x-correlation-id')).toBe('cor_fixed');
    expect(await res.json()).toEqual({ correlationId: 'cor_fixed' });
  });

  it('generates a correlation id when absent', async () => {
    const handler = withLogger('kernel', async (_req, { correlationId }) => {
      return new Response(null, { status: 200, headers: { 'x-generated': correlationId } });
    });

    const res = await handler(makeReq('https://kernel.test/api/x'));
    const header = res.headers.get('x-correlation-id')!;

    expect(header).toMatch(/^cor_/);
    expect(res.headers.get('x-generated')).toBe(header);
  });

  it('resolves the client ip from x-forwarded-for, falling back to x-real-ip then unknown', async () => {
    const handler = withLogger('kernel', async () => new Response(null, { status: 200 }));

    process.env.ENABLE_REQUEST_LOG = 'true';
    await handler(makeReq('https://kernel.test/api/x', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }));
    expect(writeRequestLog).toHaveBeenCalledWith(expect.objectContaining({ ip: '1.2.3.4' }));

    writeRequestLog.mockClear();
    await handler(makeReq('https://kernel.test/api/x', { 'x-real-ip': '9.9.9.9' }));
    expect(writeRequestLog).toHaveBeenCalledWith(expect.objectContaining({ ip: '9.9.9.9' }));

    writeRequestLog.mockClear();
    await handler(makeReq('https://kernel.test/api/x'));
    expect(writeRequestLog).toHaveBeenCalledWith(expect.objectContaining({ ip: 'unknown' }));
  });

  it('returns a 500 and logs the error when the handler throws', async () => {
    const handler = withLogger('kernel', async () => {
      throw new Error('boom');
    });

    const res = await handler(makeReq('https://kernel.test/api/x'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });
    expect(fakeLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500 }),
      'request error'
    );
  });

  it('does not call the log sink when ENABLE_REQUEST_LOG is not set', async () => {
    delete process.env.ENABLE_REQUEST_LOG;
    const handler = withLogger('kernel', async () => new Response(null, { status: 200 }));

    await handler(makeReq('https://kernel.test/api/x'));

    expect(writeRequestLog).not.toHaveBeenCalled();
  });

  it('skips SKIP_LOG_PATHS unless the response errors (>=500)', async () => {
    process.env.ENABLE_REQUEST_LOG = 'true';
    const handler = withLogger('kernel', async () => new Response(null, { status: 200 }));

    await handler(makeReq('https://kernel.test/auth/api/session'));
    expect(writeRequestLog).not.toHaveBeenCalled();

    const erroringHandler = withLogger('kernel', async () => new Response(null, { status: 500 }));
    await erroringHandler(makeReq('https://kernel.test/auth/api/session'));
    expect(writeRequestLog).toHaveBeenCalled();
  });

  it('calls the log sink for non-skip paths when ENABLE_REQUEST_LOG=true', async () => {
    process.env.ENABLE_REQUEST_LOG = 'true';
    const handler = withLogger('kernel', async () => new Response(null, { status: 201 }));

    await handler(makeReq('https://kernel.test/api/widgets'));

    expect(writeRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'kernel', method: 'GET', path: '/api/widgets', status: 201 })
    );
  });

  it('tolerates a sink that throws without failing the request', async () => {
    process.env.ENABLE_REQUEST_LOG = 'true';
    registerLogSink({
      writeRequestLog: () => {
        throw new Error('sink exploded');
      },
    });
    const handler = withLogger('kernel', async () => new Response(null, { status: 200 }));

    const res = await handler(makeReq('https://kernel.test/api/widgets'));

    expect(res.status).toBe(200);
  });
});
