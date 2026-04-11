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

function wrapPino(instance: pino.Logger): Logger {
  return {
    info(ctx: LogContext, message: string) {
      instance.info(ctx, message);
    },
    warn(ctx: LogContext, message: string) {
      instance.warn(ctx, message);
    },
    error(ctx: LogContext, message: string) {
      instance.error(ctx, message);
    },
    debug(ctx: LogContext, message: string) {
      instance.debug(ctx, message);
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
