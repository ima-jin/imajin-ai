/**
 * Browser-safe entry for `@ima-jin/auth-client` (#2643, #2647).
 *
 * Everything exported here is safe to import from a client component or any
 * browser bundle: it MUST NOT (transitively) import Node built-ins (`fs`,
 * `crypto`, `path`) or `next/headers`. Server-only helpers (session cookies,
 * the keystore, app signing keys, route handlers) stay on the main entry and
 * `./handlers`.
 */
export type { RequestAppTokenOptions, RequestAppTokenResult } from './app-token';
export { requestAppToken } from './app-token';
