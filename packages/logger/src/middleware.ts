import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { createLogger } from './adapters/pino';
import type { Logger } from './types';

export type LoggerContext = {
  log: Logger;
  correlationId: string;
};

export type LoggerHandler = (
  req: NextRequest,
  ctx: LoggerContext
) => Promise<NextResponse>;

/**
 * Next.js API route wrapper that provides structured logging and correlation IDs.
 *
 * - Reads X-Correlation-Id from the incoming request (for service-to-service calls)
 * - Generates cor_<nanoid16> if absent
 * - Creates a child logger bound to { correlationId, method, path, ip }
 * - Auto-logs request completion with { status, durationMs }
 * - Sets X-Correlation-Id on the response
 *
 * Usage:
 *   export const GET = withLogger('kernel', async (req, { log, correlationId }) => {
 *     log.info({ service: 'kernel' }, 'handling request');
 *     return NextResponse.json({ ok: true });
 *   });
 */
export function withLogger(
  service: string,
  handler: LoggerHandler
): (req: NextRequest) => Promise<NextResponse> {
  const baseLogger = createLogger(service);

  return async (req: NextRequest): Promise<NextResponse> => {
    const correlationId =
      req.headers.get('x-correlation-id') || `cor_${nanoid(16)}`;

    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      'unknown';

    const log = baseLogger.child({
      service,
      correlationId,
      method: req.method,
      path: new URL(req.url).pathname,
      ip,
    });

    const start = Date.now();

    let response: NextResponse;
    try {
      response = await handler(req, { log, correlationId });
    } catch (err) {
      const durationMs = Date.now() - start;
      log.error(
        { service, status: 500, durationMs, err: String(err) },
        'request error'
      );
      response = NextResponse.json(
        { error: 'Internal Server Error' },
        { status: 500 }
      );
    }

    const durationMs = Date.now() - start;
    log.info({ service, status: response.status, durationMs }, 'request complete');

    response.headers.set('x-correlation-id', correlationId);
    return response;
  };
}
