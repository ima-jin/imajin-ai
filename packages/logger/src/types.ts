export interface LogContext {
  service: string;
  correlationId?: string;
  did?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  ip?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(ctx: LogContext, message: string): void;
  warn(ctx: LogContext, message: string): void;
  error(ctx: LogContext, message: string): void;
  debug(ctx: LogContext, message: string): void;
  child(bindings: Partial<LogContext>): Logger;
}
