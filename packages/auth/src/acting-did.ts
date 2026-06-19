import type { Identity } from './types';

/**
 * Resolve the canonical effective DID from an authenticated identity.
 *
 * Delegation precedence:
 *   actingFor  — agent delegation: a registered bot/app acting on behalf of a user
 *   actingAs   — group impersonation: the caller is operating as a group DID
 *   id         — the caller's own DID (default, no delegation)
 *
 * This is the single definition of delegation precedence for all authenticated
 * route handlers (#1088 actingFor rollout). Every handler that needs an effective
 * DID should call this instead of hand-rolling the `||` chain.
 *
 * @example
 *   const auth = await requireAuth(request);
 *   if ('error' in auth) return ...;
 *   const effectiveDid = resolveActingDid(auth.identity);
 */
export function resolveActingDid(identity: Identity): string {
  return identity.actingFor ?? identity.actingAs ?? identity.id;
}
