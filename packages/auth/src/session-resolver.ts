import { SESSION_COOKIE_NAME } from '@imajin/config';
import { internalFetch } from './internal-fetch.cjs';
import type { Identity } from './types';

export interface SessionData {
  did?: string;
  scope?: string;
  subtype?: string;
  name?: string;
  handle?: string;
  tier?: Identity['tier'];
  email?: string | null;
  role?: string;
  chainVerified?: boolean;
  identity?: Partial<Identity> & { did?: string };
}
export type SessionResolver = (token: string) => Promise<SessionData | null>;

// Instrumentation and routes are separate Next bundles. A module-local variable
// silently falls back to HTTP in routes; this seam must be process-wide.
const RESOLVER = Symbol.for('@imajin/auth/session-resolver/v1');
const state = globalThis as typeof globalThis & { [RESOLVER]?: SessionResolver };

/** Kernel boot only. Standalone consumers do not register and keep HTTP. */
export function provideSessionResolver(resolver: SessionResolver): void {
  state[RESOLVER] = resolver;
}

/** Also used by server components and the legacy cookie adapter. */
export async function resolveSessionData(token: string): Promise<SessionData | null> {
  const resolver = state[RESOLVER];
  if (resolver) return resolver(token);
  const response = await internalFetch(`${process.env.AUTH_SERVICE_URL}/api/session`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    cache: 'no-store',
  });
  return response.ok ? response.json() : null;
}

/** Preserve the existing requireAuth Identity shape and fallback precedence. */
export function sessionIdentity(data: SessionData): Identity {
  return {
    id: data.did || data.identity?.did || data.identity?.id || '',
    scope: data.scope || data.identity?.scope || 'actor',
    subtype: data.subtype || data.identity?.subtype || undefined,
    name: data.name || data.identity?.name,
    handle: data.handle || data.identity?.handle,
    tier: data.tier || data.identity?.tier || 'soft',
  };
}
