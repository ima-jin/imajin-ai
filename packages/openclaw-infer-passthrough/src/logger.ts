/**
 * Minimal structured JSON logger.
 *
 * Deliberately does NOT depend on `@imajin/logger`: that package pulls in
 * `@imajin/db` (a real Postgres pool), which this shim has no business
 * touching — it runs standalone on the gateway host, not inside the kernel.
 * `console.*` + a JSON line is enough here and keeps the dependency surface
 * of a credential-handling process as small as possible.
 *
 * `redact` is defense-in-depth, not the primary control: the real control is
 * that call sites never pass a secret-shaped field into `log(...)` in the
 * first place (see `tests/logging-redaction.test.ts`). This just ensures a
 * mistake doesn't silently leak — any key matching a known-sensitive name is
 * replaced with `"[redacted]"` rather than printed.
 */

const SENSITIVE_KEYS = new Set([
  'token',
  'authorization',
  'signature',
  'privatekey',
  'apikey',
  'directapikey',
  'password',
  'secret',
]);

export type LogFields = Record<string, unknown>;

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface Logger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

function write(level: 'info' | 'warn' | 'error', name: string, fields: LogFields, message: string): void {
  const line = JSON.stringify({
    level,
    name,
    time: new Date().toISOString(),
    msg: message,
    ...redact(fields),
  });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(name: string): Logger {
  return {
    info: (fields, message) => write('info', name, fields, message),
    warn: (fields, message) => write('warn', name, fields, message),
    error: (fields, message) => write('error', name, fields, message),
  };
}
