/**
 * Connector detail card routing, as a pure projection of the registry (#1604).
 *
 * `ConnectorDetail` used to dispatch by connector **id**, which meant every new
 * connector needed a bespoke card AND a hand-added `if (entry.id === 'x')` line.
 * #1432 shipped the Gemini registry entry and backend but not the dispatcher
 * line, so `/auth/connectors/gemini` rendered "Coming soon" while its routes
 * were live; #1428/#1602 did the same to Warp. Both were invisible until someone
 * opened the page.
 *
 * Routing is now derived from `ingestionPattern`, so the class of bug is gone:
 * adding a connector with an existing pattern is a registry entry, full stop.
 * The switch below is exhaustive over `IngestionPattern` — a new pattern is a
 * typecheck failure here rather than a silent fall-through to the pending card.
 *
 * IMPORTANT: this file must remain client-safe (no node: imports, no DB, no
 * vault) so it can be imported by both client components and tests.
 */
import type { ConnectorEntry } from './connector-registry';

/**
 * Which detail card a registry entry resolves to.
 *
 * - `pending`          — backend not implemented yet; renders read-only.
 * - `native`           — credential-free; scope toggles only.
 * - `oauth`            — configure app → redirect round-trip → grant scopes.
 * - `credential-paste` — paste a credential, seal it per-DID, grant scopes.
 *                        Covers `token-paste` and `static-secret`, which differ
 *                        only in the POST body key and the disconnect verb.
 */
export type ConnectorCardKind = 'pending' | 'native' | 'oauth' | 'credential-paste';

/** Resolve the detail card kind for a registry entry. */
export function connectorCardKind(entry: ConnectorEntry): ConnectorCardKind {
  if (entry.backendPending) return 'pending';

  switch (entry.ingestionPattern) {
    case 'native':
      return 'native';
    case 'oauth':
      return 'oauth';
    case 'token-paste':
    case 'static-secret':
      return 'credential-paste';
  }
}

/**
 * The POST body key a credential-paste connector expects for its credential.
 *
 * Token-paste routes (`/discord/api/token`, `/gemini/api/token`) take `token`;
 * the static-secret factory (#1439, `/warp/api/seal`) takes `secret`.
 */
export function credentialBodyKey(entry: ConnectorEntry): 'token' | 'secret' {
  return entry.ingestionPattern === 'static-secret' ? 'secret' : 'token';
}

/**
 * The HTTP method that disconnects a credential-paste connector.
 *
 * Token-paste connectors have a dedicated `/disconnect` POST route. Static-secret
 * connectors serve seal (POST) and grant-revocation (DELETE) from one route, so
 * their `disconnectRoute` is the seal route and the verb carries the intent.
 */
export function disconnectMethod(entry: ConnectorEntry): 'POST' | 'DELETE' {
  return entry.ingestionPattern === 'static-secret' ? 'DELETE' : 'POST';
}

/**
 * Shape of the credential-status booleans a connector status endpoint may return.
 *
 * The three connector families named their sealed flag independently before this
 * was ever read generically: Discord returns `tokenSealed`, Gemini returns
 * `keySealed`, and the static-secret factory returns `secretSealed`. Those are
 * signed/deployed response contracts, so the UI normalises instead of renaming
 * server-side.
 */
export interface CredentialSealedFlags {
  tokenSealed?: boolean;
  keySealed?: boolean;
  secretSealed?: boolean;
}

/** True when a status payload reports a sealed credential under any of its names. */
export function credentialSealed(status: CredentialSealedFlags): boolean {
  return status.tokenSealed === true || status.keySealed === true || status.secretSealed === true;
}
