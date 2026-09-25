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

/**
 * Resolve the DID that *composed* a request, when it differs from the DID the
 * request is attributed to (#1673).
 *
 * `resolveActingDid` answers "whose record is this?". This answers "who typed
 * it?". They differ only under `actingFor` delegation — a registered agent
 * writing on a human's behalf via `X-Acting-For`. In that case the agent's own
 * DID is the composer and the human keeps the attribution.
 *
 * Returns null when there is no delegation, when the caller is acting as a
 * group (`actingAs` is impersonation of a shared identity, not transcription),
 * or when the agent is somehow delegated to itself — a null here must always
 * mean "the attributed identity composed this", never "we didn't check".
 *
 * @example
 *   const auth = await requireAuth(request);
 *   if ('error' in auth) return ...;
 *   const fromDid = resolveActingDid(auth.identity);
 *   const composedBy = resolveComposedBy(auth.identity);
 */
export function resolveComposedBy(identity: Identity): string | null {
  if (!identity.actingFor || identity.actingFor === identity.id) return null;
  return identity.id;
}

/**
 * True when this request is running under act-as — i.e. the acting DID the
 * request would be attributed to is NOT the real authenticated session DID
 * (#2359).
 *
 * Covers BOTH delegation overlays `resolveActingDid` understands:
 *   actingFor — an agent delegated to a human (`X-Acting-For`)
 *   actingAs  — a human operating as a group DID (`x-acting-as` header/cookie)
 *
 * `resolveActingDid` answers "whose record is this?"; this answers "is that
 * somebody other than whoever actually signed in?". A self-only rail — one
 * where the real human must be the party on the hook, e.g. the /jin confirm
 * rail (#2359) — refuses the request outright whenever this is true, rather
 * than comparing `resolveActingDid(identity)` against the owner and
 * accidentally accepting a borrowed identity.
 *
 * @example
 *   const auth = await requireAuth(request);
 *   if ('error' in auth) return ...;
 *   if (isUnderActAs(auth.identity)) return forbidden('act_as_not_permitted');
 */
export function isUnderActAs(identity: Identity): boolean {
  return resolveActingDid(identity) !== identity.id;
}
