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
 * Fire-and-forget insert into registry.logs (source='request').
 * Only runs when ENABLE_REQUEST_LOG=true.
 */
function writeRequestLog(entry: {
  service: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  correlationId: string;
  ip: string;
  errorMessage?: string;
}): void {
  if (process.env.ENABLE_REQUEST_LOG !== 'true') return;

  // Dynamically import to avoid loading @imajin/db at startup when not needed
  import('@imajin/db')
    .then(({ getClient }) => {
      const sql = getClient();
      const id = `req_${nanoid(16)}`;
      const level = entry.status >= 500 ? 'error' : entry.status >= 400 ? 'warn' : 'info';
      const message = entry.errorMessage || `${entry.method} ${entry.path} → ${entry.status}`;
      return sql`
        INSERT INTO registry.logs
          (id, source, service, level, message, method, path, status, duration_ms, correlation_id, ip, error_message, created_at)
        VALUES
          (${id}, 'request', ${entry.service}, ${level}, ${message}, ${entry.method}, ${entry.path}, ${entry.status},
           ${entry.durationMs}, ${entry.correlationId}, ${entry.ip},
           ${entry.errorMessage ?? null}, now())
      `;
    })
    .catch(() => {
      // Silently ignore — never block or surface errors from the log sink
    });
}

/**
 * Next.js API route wrapper that provides structured logging and correlation IDs.
 *
 * - Reads X-Correlation-Id from the incoming request (for service-to-service calls)
 * - Generates cor_<nanoid16> if absent
 * - Creates a child logger bound to { correlationId, method, path, ip }
 * - Auto-logs request completion with { status, durationMs }
 * - Sets X-Correlation-Id on the response
 * - Optionally writes to registry.logs when ENABLE_REQUEST_LOG=true
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

    const path = new URL(req.url).pathname;

    const log = baseLogger.child({
      service,
      correlationId,
      method: req.method,
      path,
      ip,
    });

    const start = Date.now();

    let response: NextResponse;
    let errorMessage: string | undefined;
    try {
      response = await handler(req, { log, correlationId });
    } catch (err) {
      const durationMs = Date.now() - start;
      errorMessage = String(err);
      log.error(
        { service, status: 500, durationMs, err: errorMessage },
        'request error'
      );
      response = NextResponse.json(
        { error: 'Internal Server Error' },
        { status: 500 }
      );
    }

    const durationMs = Date.now() - start;
    log.info({ service, status: response.status, durationMs }, 'request complete');

    writeRequestLog({
      service,
      method: req.method,
      path,
      status: response.status,
      durationMs,
      correlationId,
      ip,
      errorMessage,
    });

    response.headers.set('x-correlation-id', correlationId);
    return response;
  };
}
