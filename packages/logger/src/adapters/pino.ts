import pino from 'pino';
import type { Logger, LogContext } from '../types';
import { getLogSink } from '../sink';

const REDACT_PATHS = [
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  '*.password',
  '*.token',
  '*.secret',
  '*.key',
  '*.authorization',
];

const MIN_PERSIST_LEVEL = process.env.APP_LOG_LEVEL || 'warn';
const LEVEL_PRIORITY: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldPersist(level: string): boolean {
  const enabled = process.env.LOG_DB_TRANSPORT === 'true' || process.env.ENABLE_APP_LOG === 'true';
  if (!enabled) return false;
  return (LEVEL_PRIORITY[level] ?? 0) >= (LEVEL_PRIORITY[MIN_PERSIST_LEVEL] ?? 30);
}

/**
 * Fire-and-forget handoff to the registered log sink (source='app').
 * Only runs above `shouldPersist`'s threshold and when a sink has been
 * registered (see `@imajin/logger/db` — core `@imajin/logger` has no DB
 * dependency).
 */
function writeAppLog(entry: {
  service: string;
  level: string;
  message: string;
  correlationId?: string;
  did?: string;
  method?: string;
  path?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}): void {
  if (!shouldPersist(entry.level)) return;

  try {
    getLogSink()?.writeAppLog?.(entry);
  } catch {
    // Never block or surface errors from the log sink
  }
}

function formatErrorMessage(source: unknown): string | undefined {
  if (!source) return undefined;
  if (source instanceof Error) return source.message;
  if (typeof source === 'string') return source;
  return JSON.stringify(source);
}

function persist(level: string, ctx: LogContext, message: string) {
  const { service, correlationId, did, method, path, err, error, ...rest } = ctx;
  const errorMessage = formatErrorMessage(err ?? error);
  writeAppLog({
    service: service || 'unknown',
    level,
    message,
    correlationId,
    did,
    method,
    path,
    errorMessage,
    metadata: Object.keys(rest).length > 0 ? rest : undefined,
  });
}

function wrapPino(instance: pino.Logger): Logger {
  return {
    info(ctx: LogContext, message: string) {
      instance.info(ctx, message);
      persist('info', ctx, message);
    },
    warn(ctx: LogContext, message: string) {
      instance.warn(ctx, message);
      persist('warn', ctx, message);
    },
    error(ctx: LogContext, message: string) {
      instance.error(ctx, message);
      persist('error', ctx, message);
    },
    debug(ctx: LogContext, message: string) {
      instance.debug(ctx, message);
      persist('debug', ctx, message);
    },
    child(bindings: Partial<LogContext>): Logger {
      return wrapPino(instance.child(bindings));
    },
  };
}

export function createLogger(service: string): Logger {
  const instance = pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[redacted]',
    },
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  });

  return wrapPino(instance.child({ service }));
}
