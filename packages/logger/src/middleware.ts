import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { createLogger } from './adapters/pino';
import type { Logger } from './types';
import { getLogSink } from './sink';

export type LoggerContext = {
  log: Logger;
  correlationId: string;
};

export type LoggerHandler = (
  req: NextRequest,
  ctx: LoggerContext
) => Promise<Response>;

/**
 * Paths excluded from DB request logging.
 * High-frequency polling endpoints that generate noise without diagnostic value.
 * Still logged to stdout via pino — only the DB insert is suppressed.
 */
const SKIP_LOG_PATHS = new Set([
  '/auth/api/session',
  '/chat/api/conversations/unread',
  '/profile/api/presence/update',
]);

/**
 * Fire-and-forget handoff to the registered log sink (source='request').
 * Only runs when ENABLE_REQUEST_LOG=true and a sink has been registered
 * (see `@imajin/logger/db` — core `@imajin/logger` has no DB dependency).
 * Skips paths in SKIP_LOG_PATHS (polling endpoints) unless the response is an error (≥500).
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

  // Skip high-frequency polling endpoints unless they error
  if (SKIP_LOG_PATHS.has(entry.path) && entry.status < 500) return;

  try {
    getLogSink()?.writeRequestLog?.(entry);
  } catch {
    // Never block or surface errors from the log sink
  }
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
): (req: NextRequest) => Promise<Response> {
  const baseLogger = createLogger(service);

  return async (req: NextRequest): Promise<Response> => {
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

    let response: Response;
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
