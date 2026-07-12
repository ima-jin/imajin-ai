import type { NextRequest } from 'next/server';
import type { Identity } from '@imajin/auth';

/**
 * Shared typed mocks for media route-handler tests (#1258 / cluster C3).
 *
 * These replace ad-hoc inline mocks that drifted from the real types:
 * - `Identity` literals were missing the required `scope` field (TS2741).
 * - Plain `Request` objects were passed where handlers expect `NextRequest`
 *   (TS2345).
 */

/**
 * A fully-typed {@link Identity} for route tests. Defaults to an owner actor;
 * pass overrides for other DIDs/scopes.
 */
export function mockIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: 'did:imajin:owner',
    scope: 'actor',
    actingAs: undefined,
    ...overrides,
  };
}

/**
 * Build a `NextRequest` for route-handler tests. The handlers only use standard
 * `Request` members (`.json()`, `.url`), so a `Request` cast to `NextRequest`
 * is behaviourally identical while satisfying the handler signatures.
 */
export function mockRequest(
  body: unknown,
  url = 'https://test.imajin.ai/',
  method = 'PATCH',
): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}
