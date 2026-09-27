import { vi } from 'vitest';

/**
 * Shared scaffolding for the #2393 media-route auth-mode test suites
 * (assets-upload-route, content-route, asset-detail-route). Extracted so the
 * near-identical `@imajin/auth` / `@/src/lib/http/node-url` mock blocks and
 * app-token fixtures those three files previously hand-copied don't count as
 * new-code duplication.
 *
 * `createAuthMock` is imported directly into each file's own `vi.mock(...)`
 * factory call — safe under Vitest's hoisting because static `import`
 * bindings are always resolved before any module's top-level code (including
 * a hoisted `vi.mock` call) runs; only mutable per-file mock state needs
 * `vi.hoisted()`.
 */

/** Minimal shape `resolveActingDid` needs — mirrors the real `Identity`. */
export interface MockIdentityLike {
  actingFor?: string;
  actingAs?: string;
  id: string;
}

/** Build the `@imajin/auth` mock factory shared by every media auth-mode test file. */
export function createAuthMock(verifyAppTokenMock: ReturnType<typeof vi.fn>) {
  return {
    requireAuth: vi.fn(async () => ({ identity: { id: 'did:imajin:owner', scope: 'actor' } })),
    resolveActingDid: vi.fn((identity: MockIdentityLike) => identity.actingFor ?? identity.actingAs ?? identity.id),
    verifyAppToken: verifyAppTokenMock,
  };
}

/** The `@/src/lib/http/node-url` mock shared by every media auth-mode test file. */
export function createNodeUrlMock() {
  return { nodeUrl: vi.fn(() => 'https://jin.test') };
}

/** The `@imajin/logger` mock shared by every media route test file. */
export function createLoggerMock() {
  return { createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })) };
}

/** A scoped app-token verification result, as `verifyAppToken` resolves it. */
export function appToken(scopes: string[], sub = 'did:imajin:app-user') {
  return { sub, aud: 'jin.test', scopes };
}

/** An app-token minted with `media:write` but not `media:read`, or vice versa. */
export const APP_TOKEN_WRITE_ONLY = ['media:write'];
export const APP_TOKEN_READ_ONLY = ['media:read'];
export const APP_TOKEN_NO_SCOPES: string[] = [];
