/**
 * Browser-safe entry — `@ima-jin/auth-client/browser` (#2643).
 *
 * Exports ONLY what can run in a client bundle: `requestAppToken` and its
 * types. This module must never (transitively) import node built-ins
 * (`fs`, `crypto`, `path`, `node:*`), `next/headers`, or the keystore /
 * signing-key code — `tests/browser-entry.test.ts` enforces that by
 * bundling this file for a browser target.
 */
export type { RequestAppTokenOptions, RequestAppTokenResult } from './app-token';
export { requestAppToken } from './app-token';
