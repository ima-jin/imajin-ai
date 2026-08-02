/**
 * Client-side counterpart to the connector OAuth callback (#1529).
 *
 * The callback redirects the browser back into the app carrying its result in
 * the query string (`?connected=<id>` or `?error=<code>&connector=<id>`). This
 * module owns the two pure pieces of that round-trip:
 *
 *   - building the connect URL that asks to be returned here, and
 *   - reading the result back off the URL and turning a stable error code into
 *     copy a person can act on.
 *
 * Deliberately free of React and of `next/navigation` so the logic can be
 * tested directly rather than through a rendered component. `ConnectorDetail`
 * supplies the `URLSearchParams` and renders whatever comes back.
 */

/**
 * Human copy for the `?error=` codes emitted by `createCallbackHandler`
 * (see `connector-oauth-routes.ts`). The callback puts only a stable code in
 * the URL — never raw exception text — so the mapping to something actionable
 * lives here on the client.
 */
const CONNECT_ERROR_COPY: Record<string, string> = {
  missing_params: "The provider didn't send back a complete authorization response. Please try connecting again.",
  invalid_state: 'That connection attempt expired or was already used. Please start the connection again.',
  missing_param: "The provider's response was missing required account information. Please try connecting again.",
  credential_pending: 'Your credentials were saved and are waiting for owner approval before the connection goes live.',
  exchange_failed: "We couldn't finish the handshake with the provider. Please try again in a moment.",
};

/** Shown when the callback sends a code we don't have specific copy for. */
const CONNECT_ERROR_FALLBACK = "That connection attempt didn't complete. Please try again.";

/** The path a connector's detail view lives at. */
export function connectorDetailPath(connectorId: string): string {
  return `/auth/connectors/${connectorId}`;
}

/**
 * Build the connect/reconnect URL, threading the connector's own detail page
 * through as `returnTo` so the callback lands the browser back there instead
 * of on a bare JSON page.
 *
 * This is only a hint: the kernel re-validates `returnTo` as a same-origin path
 * before signing it, and again after verifying the state.
 */
export function buildConnectHref(connectRoute: string, connectorId: string): string {
  const returnTo = encodeURIComponent(connectorDetailPath(connectorId));
  return `${connectRoute}?returnTo=${returnTo}`;
}

/** What the URL says about a just-completed connect attempt. */
export interface ConnectOutcome {
  /** This connector reported a successful connect. */
  connected: boolean;
  /** Ready-to-render failure copy, or `null` when there is nothing to report. */
  errorMessage: string | null;
}

const NO_OUTCOME: ConnectOutcome = { connected: false, errorMessage: null };

/**
 * Interpret the callback's query params for a single connector.
 *
 * Both the success and failure params are tagged with the connector id, and we
 * match on it, so a stale `?connected=github` left in the URL cannot light up
 * the QuickBooks card. Success wins over a leftover error param.
 */
export function readConnectOutcome(
  params: Pick<URLSearchParams, 'get'>,
  connectorId: string,
): ConnectOutcome {
  if (params.get('connected') === connectorId) {
    return { connected: true, errorMessage: null };
  }

  if (params.get('connector') !== connectorId) return NO_OUTCOME;

  const code = params.get('error');
  if (!code) return NO_OUTCOME;

  return { connected: false, errorMessage: CONNECT_ERROR_COPY[code] ?? CONNECT_ERROR_FALLBACK };
}
