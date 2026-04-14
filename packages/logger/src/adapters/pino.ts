import pino from 'pino';
import type { Logger, LogContext } from '../types';

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
  if (process.env.ENABLE_APP_LOG !== 'true') return false;
  return (LEVEL_PRIORITY[level] ?? 0) >= (LEVEL_PRIORITY[MIN_PERSIST_LEVEL] ?? 30);
}

function writeAppLog(entry: {
  service: string;
  level: string;
  message: string;
  correlationId?: string;
  did?: string;
  method?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}): void {
  if (!shouldPersist(entry.level)) return;

  import('@imajin/db')
    .then(({ getClient }) => {
      const sql = getClient();
      const id = `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      return sql`
        INSERT INTO registry.app_logs (id, service, level, message, correlation_id, did, method, path, metadata)
        VALUES (${id}, ${entry.service}, ${entry.level}, ${entry.message},
                ${entry.correlationId ?? null}, ${entry.did ?? null},
                ${entry.method ?? null}, ${entry.path ?? null},
                ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb)
      `;
    })
    .catch(() => {
      // Never block or surface errors from the log sink
    });
}

function wrapPino(instance: pino.Logger): Logger {
  function persist(level: string, ctx: LogContext, message: string) {
    const { service, correlationId, did, method, path, ...rest } = ctx;
    writeAppLog({
      service: service || 'unknown',
      level,
      message,
      correlationId,
      did,
      method,
      path,
      metadata: Object.keys(rest).length > 0 ? rest : undefined,
    });
  }

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
      return wrapPino(instance.child(bindings as Record<string, unknown>));
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
