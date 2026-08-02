/**
 * Shared Next.js App Router handler factories for OAuth connector routes (#1333).
 *
 * Every connector needs the same three routes: connect (start authorize redirect),
 * callback (exchange code + seal tokens), and configure (seal per-DID app config).
 * The bodies were identical or near-identical across connectors. This file
 * centralises them so each route file is a thin 4–8 line delegation.
 *
 * Exports:
 *   createConnectHandler    — GET: requireAuth → buildAuthorizeUrl → redirect
 *   createCallbackHandler   — GET: verifyState → exchange → redirect into the app
 *   MissingCallbackParamError — throw inside `exchange` to signal a bad request
 *   createDisconnectHandler — POST: auth → purge vault → revoke grant → event
 *   createConfigureHandler  — OPTIONS + POST: auth → validate → storeConfig
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { deleteFromVault } from '@/src/lib/vault';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { sanitizeReturnTo } from '@/src/lib/kernel/oauth-return-to';
import { ConnectorCredentialPendingError, type BaseOAuthConfig } from './connector-oauth';
import type { VerifiedState } from './connector-oauth-state';

const log = createLogger('kernel');

// ── Connect ───────────────────────────────────────────────────────────────────

/**
 * Build a session-gated `GET` handler that starts the OAuth2 authorize redirect.
 * The caller supplies the connector's `buildAuthorizeUrl` and `signState` so
 * the handler has no knowledge of the specific provider.
 *
 * An optional `?returnTo=` query param is validated as a same-origin app path
 * and signed into `state`, so the callback can put the browser back where the
 * user started the flow (#1529). An off-origin value is dropped rather than
 * rejected — the connect still succeeds, it just lands on the default page.
 */
export function createConnectHandler(
  buildAuthorizeUrl: (ownerDid: string, state: string) => Promise<string>,
  signState: (ownerDid: string, returnTo?: string) => string,
) {
  return async function GET(request: NextRequest) {
    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const ownerDid = resolveActingDid(auth.identity);
    const { searchParams } = new URL(request.url);
    const returnTo = sanitizeReturnTo(searchParams.get('returnTo'));
    try {
      return NextResponse.redirect(await buildAuthorizeUrl(ownerDid, signState(ownerDid, returnTo ?? undefined)));
    } catch (err) {
      if (err instanceof ConnectorCredentialPendingError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  };
}

// ── Callback ──────────────────────────────────────────────────────────────────

/**
 * Throw inside `exchange` when a required provider-specific callback param
 * (e.g. Intuit's `realmId`) is absent, so the handler can distinguish a
 * malformed callback from a genuine token-exchange failure.
 */
export class MissingCallbackParamError extends Error {
  constructor(param: string) {
    super(`Missing ${param}`);
  }
}

/**
 * Stable, machine-readable failure codes appended to the landing page as
 * `?error=`. The UI maps these to human copy — the raw exception text is only
 * ever written to the server log, never to the URL.
 */
export type ConnectCallbackError =
  | 'missing_params'
  | 'invalid_state'
  | 'missing_param'
  | 'credential_pending'
  | 'exchange_failed';

/** Where a connector's callback lands the browser when no `returnTo` was signed. */
function defaultLandingPath(connectorId: string): string {
  return `/auth/connectors/${connectorId}`;
}

/**
 * Build a `GET` handler for the OAuth2 callback route. The callback arrives
 * without an imajin session; the signed `state` authenticates the owner DID.
 *
 * This route is the **browser redirect target** from the provider, not an API
 * endpoint — so every branch ends in a redirect back into the app rather than a
 * JSON body the user would be stranded on (#1529). Success lands on the signed
 * `returnTo` (or `/auth/connectors/<id>`) with `?connected=<id>`; failures land
 * on the same page with `?error=<code>&connector=<id>`.
 *
 * `exchange` receives the verified `ownerDid`, `code`, and the raw
 * `URLSearchParams` so callers can extract provider-specific params (e.g.
 * Intuit's `realmId`). Throw `MissingCallbackParamError` for a bad callback.
 */
export function createCallbackHandler(opts: {
  verifyState(state: string): VerifiedState;
  exchange(ownerDid: string, code: string, searchParams: URLSearchParams): Promise<void>;
  connectorName: string;
  /** Registry id (e.g. `'quickbooks'`) — drives the default landing page. */
  connectorId: string;
}) {
  const fallback = defaultLandingPath(opts.connectorId);

  /** Build an absolute same-origin redirect to `path` with one param set. */
  function landing(request: NextRequest, path: string, key: string, value: string) {
    const url = new URL(path, request.url);
    url.searchParams.set(key, value);
    return url;
  }

  function fail(request: NextRequest, path: string, code: ConnectCallbackError) {
    const url = landing(request, path, 'error', code);
    url.searchParams.set('connector', opts.connectorId);
    return NextResponse.redirect(url);
  }

  return async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code || !state) {
      return fail(request, fallback, 'missing_params');
    }

    let verified: VerifiedState;
    try {
      verified = opts.verifyState(state);
    } catch (err) {
      // A bad state means `returnTo` is unrecoverable (and untrustworthy), so
      // this branch can only ever land on the default page.
      log.warn({ err: String(err) }, `${opts.connectorName} callback: invalid state`);
      return fail(request, fallback, 'invalid_state');
    }

    const ownerDid = verified.did;
    // Re-validate after verification: the HMAC already proves we signed this
    // value, but re-checking keeps a leaked signing key from escalating into an
    // open redirect.
    const dest = sanitizeReturnTo(verified.returnTo) ?? fallback;

    try {
      await opts.exchange(ownerDid, code, searchParams);
    } catch (err) {
      if (err instanceof MissingCallbackParamError) {
        return fail(request, dest, 'missing_param');
      }
      if (err instanceof ConnectorCredentialPendingError) {
        return fail(request, dest, 'credential_pending');
      }
      log.error({ err: String(err), ownerDid }, `${opts.connectorName} callback: token exchange failed`);
      return fail(request, dest, 'exchange_failed');
    }

    return NextResponse.redirect(landing(request, dest, 'connected', opts.connectorId));
  };
}

// ── Disconnect ────────────────────────────────────────────────────────────────

/**
 * Build a `POST` handler that disconnects a connector for the authenticated DID.
 *
 * Steps (all idempotent — safe to call even when provider-side app is already gone):
 *   1. requireAuth → resolve ownerDid.
 *   2. Tombstone all sealed vault fields (config, oauth token bundle, PAT fallback).
 *      `deleteFromVault` is a no-op on absent fields — no error on already-clean state.
 *   3. Revoke the active `auth.channel_links` grant row (status → 'revoked').
 *      A WHERE on status='active' makes it a no-op when already revoked.
 *   4. Publish a `<connectorName>.disconnected` bus event for audit trail (non-fatal).
 *   5. Return `{ connected: false }`.
 *
 * Usage (one-liner per connector):
 *   export const POST = createDisconnectHandler({ vaultPrefixes, channel, connectorDid, connectorName });
 */
export function createDisconnectHandler(opts: {
  /**
   * Vault key prefixes (without `:${ownerDid}`) to tombstone on disconnect, e.g.
   * `['github-config', 'github-oauth', 'github-pat']`.
   */
  vaultPrefixes: string[];
  /** Channel name in channel_links, e.g. `'github'`. */
  channel: string;
  /** Connector app DID in channel_links, e.g. `'did:imajin:github-connector'`. */
  connectorDid: string;
  /** Short connector name for bus event topic and log messages, e.g. `'github'`. */
  connectorName: string;
}) {
  return async function POST(request: NextRequest) {
    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const ownerDid = resolveActingDid(auth.identity);

    // Tombstone all sealed vault fields (idempotent — absent fields are a no-op).
    await Promise.all(
      opts.vaultPrefixes.map((prefix) => deleteFromVault(`${prefix}:${ownerDid}`)),
    );

    // Revoke the active channel_links grant row (no-op when already revoked).
    await db
      .update(channelLinks)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        and(
          eq(channelLinks.channel, opts.channel),
          eq(channelLinks.did, ownerDid),
          eq(channelLinks.appDid, opts.connectorDid),
          eq(channelLinks.status, 'active'),
        ),
      );

    // Publish bus event for audit trail (non-fatal).
    publish('connector.disconnected', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: opts.channel,
      payload: {
        ownerDid,
        connector: opts.connectorName,
        context_id: ownerDid,
        context_type: opts.connectorName,
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err), ownerDid }, `${opts.connectorName} disconnect: bus publish failed (non-fatal)`);
    });

    return NextResponse.json({ connected: false });
  };
}

// ── Configure ─────────────────────────────────────────────────────────────────

/**
 * Build `OPTIONS` + `POST` handlers for the per-DID connector config route.
 * The `POST` handler validates the three common fields (`clientId`,
 * `clientSecret`, `redirectUri`), then calls `buildConfig` so the caller can
 * add provider-specific fields (e.g. QuickBooks' `environment`), then seals
 * the result via `storeConfig`.
 *
 * Usage:
 *   export const { OPTIONS, POST } = createConfigureHandler({ buildConfig, storeConfig });
 */
export function createConfigureHandler<TConfig extends BaseOAuthConfig>(opts: {
  buildConfig(base: BaseOAuthConfig, body: Record<string, unknown>): TConfig;
  storeConfig(ownerDid: string, config: TConfig): Promise<void>;
}) {
  return {
    OPTIONS: async (request: NextRequest) =>
      new NextResponse(null, { status: 204, headers: corsHeaders(request) }),

    POST: async (request: NextRequest) => {
      const cors = corsHeaders(request);

      const auth = await requireAuth(request);
      if ('error' in auth) {
        return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
      }
      const ownerDid = resolveActingDid(auth.identity);

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
      }

      const clientId = typeof body.clientId === 'string' ? body.clientId : null;
      const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : null;
      const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : null;
      if (!clientId || !clientSecret || !redirectUri) {
        return NextResponse.json(
          { error: 'clientId, clientSecret and redirectUri are required' },
          { status: 400, headers: cors },
        );
      }

      const config = opts.buildConfig({ clientId, clientSecret, redirectUri }, body);
      await opts.storeConfig(ownerDid, config);
      return NextResponse.json({ configured: true }, { status: 201, headers: cors });
    },
  };
}
