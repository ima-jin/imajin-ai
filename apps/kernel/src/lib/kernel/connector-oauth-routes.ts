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
 *   createDeviceStartHandler — POST: auth → requestDeviceCode → signed ticket
 *   createDevicePollHandler  — POST: auth → verify ticket → one poll tick
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
import {
  ConnectorCredentialPendingError,
  type BaseOAuthConfig,
  type DeviceAuthorization,
  type DevicePollStatus,
  type OAuthFlow,
} from './connector-oauth';
import type { VerifiedState } from './connector-oauth-state';
import type { DeviceTicketHelpers } from './connector-device-ticket';

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

// ── Configure ────────────────────────────────────────────────────────────

/** Read a request-body field as a trimmed non-empty string, else null. */
function stringField(body: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = body[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Which flow a configure POST is asking for (#1391).
 *
 * An explicit `flow` in the body wins so the UI can be unambiguous. Otherwise
 * the presence of a secret or a redirect URI is taken as authorization-code,
 * which keeps every pre-#1391 client — which sends all three fields and no
 * `flow` — on exactly the path it has always been on.
 */
function requestedFlow(body: Readonly<Record<string, unknown>>): OAuthFlow {
  if (body.flow === 'device' || body.flow === 'authorization_code') return body.flow;
  const sentAuthCodeFields =
    stringField(body, 'clientSecret') !== null || stringField(body, 'redirectUri') !== null;
  return sentAuthCodeFields ? 'authorization_code' : 'device';
}

/** Validated configure body, or the 400 message explaining what was missing. */
type ConfigureParse =
  | { ok: true; base: BaseOAuthConfig }
  | { ok: false; error: string };

/**
 * Validate a configure body for the flow it asked for.
 *
 * Device mode deliberately rejects a `clientSecret` / `redirectUri` rather than
 * ignoring them: silently sealing a secret the device path will never use is
 * exactly the "we hold credentials you didn't need to give us" behaviour #1391
 * exists to avoid.
 */
function parseConfigureBody(
  body: Readonly<Record<string, unknown>>,
  deviceFlowSupported: boolean,
): ConfigureParse {
  const clientId = stringField(body, 'clientId');
  const clientSecret = stringField(body, 'clientSecret');
  const redirectUri = stringField(body, 'redirectUri');
  const flow = requestedFlow(body);

  if (flow === 'device') {
    if (!deviceFlowSupported) {
      return { ok: false, error: 'This connector does not support device flow' };
    }
    if (!clientId) {
      return { ok: false, error: 'clientId is required' };
    }
    if (clientSecret !== null || redirectUri !== null) {
      return {
        ok: false,
        error: 'device flow takes clientId only — remove clientSecret and redirectUri',
      };
    }
    return { ok: true, base: { clientId, flow } };
  }

  if (!clientId || !clientSecret || !redirectUri) {
    return { ok: false, error: 'clientId, clientSecret and redirectUri are required' };
  }
  return { ok: true, base: { clientId, clientSecret, redirectUri, flow } };
}

/**
 * Build `OPTIONS` + `POST` handlers for the per-DID connector config route.
 *
 * The `POST` handler validates the body for the requested flow, calls
 * `buildConfig` so the caller can add provider-specific fields (e.g.
 * QuickBooks' `environment`), then seals the result via `storeConfig`.
 *
 * Flows (#1391):
 *   - authorization_code (default when a secret or redirect URI is present)
 *     — requires clientId + clientSecret + redirectUri, as before.
 *   - device — requires clientId only, and is accepted only when the connector
 *     opts in with `supportsDeviceFlow: true`.
 *
 * Usage:
 *   export const { OPTIONS, POST } = createConfigureHandler({ buildConfig, storeConfig });
 */
export function createConfigureHandler<TConfig extends BaseOAuthConfig>(opts: {
  buildConfig(base: BaseOAuthConfig, body: Record<string, unknown>): TConfig;
  storeConfig(ownerDid: string, config: TConfig): Promise<void>;
  /**
   * Accept clientId-only device-mode configs. Defaults to false so connectors
   * whose provider has no RFC 8628 endpoint cannot seal a config their connect
   * route could never use.
   */
  supportsDeviceFlow?: boolean;
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

      const parsed = parseConfigureBody(body, opts.supportsDeviceFlow === true);
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
      }

      const config = opts.buildConfig(parsed.base, body);
      await opts.storeConfig(ownerDid, config);
      return NextResponse.json(
        { configured: true, flow: parsed.base.flow },
        { status: 201, headers: cors },
      );
    },
  };
}

// ── Device authorization grant (#1391) ──────────────────────────────────────

/**
 * JSON body returned by a device-start route.
 *
 * `deviceCode` is deliberately absent: the browser gets an opaque `ticket`
 * instead, so the raw device code never leaves the server unbound from the DID
 * that owns the flow.
 */
export interface DeviceStartResponse {
  ticket: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

/**
 * Map a thrown connector error onto an HTTP status.
 *
 * `no_config` and `device_unsupported` are user-fixable setup problems, not
 * server faults, so they must not surface as 500s the user cannot act on.
 */
function deviceErrorStatus(message: string): number {
  if (message.includes('_credential_pending')) return 409;
  if (message.includes('_no_config')) return 400;
  if (message.includes('_device_unsupported')) return 400;
  if (message.includes('_device_code')) return 502;
  return 500;
}

/** Shared error → JSON response mapping for both device routes. */
function deviceFailure(connectorName: string, err: unknown, phase: string) {
  const message = err instanceof Error ? err.message : String(err);
  const status = deviceErrorStatus(message);
  // 5xx means the provider or we misbehaved; log it. 4xx is the user's setup.
  if (status >= 500) {
    log.error({ err: message, connector: connectorName }, `${connectorName} device ${phase} failed`);
  }
  return NextResponse.json({ error: message }, { status });
}

/**
 * Build a session-gated `POST` handler that starts a device flow.
 *
 * Returns the human-facing `userCode` + `verificationUri` plus an opaque
 * `ticket` the client hands back to the poll route.
 */
export function createDeviceStartHandler(opts: {
  requestDeviceCode(ownerDid: string): Promise<DeviceAuthorization>;
  signDeviceTicket: DeviceTicketHelpers['signDeviceTicket'];
  /** Short connector name for log messages, e.g. `'github'`. */
  connectorName: string;
}) {
  return async function POST(request: NextRequest) {
    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const ownerDid = resolveActingDid(auth.identity);

    try {
      const grant = await opts.requestDeviceCode(ownerDid);
      const payload: DeviceStartResponse = {
        ticket: opts.signDeviceTicket(ownerDid, grant.deviceCode),
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        verificationUriComplete: grant.verificationUriComplete,
        expiresIn: grant.expiresIn,
        interval: grant.interval,
      };
      return NextResponse.json(payload, { status: 201 });
    } catch (err) {
      return deviceFailure(opts.connectorName, err, 'start');
    }
  };
}

/** JSON body returned by a device-poll route. */
export interface DevicePollResponse {
  status: DevicePollStatus;
}

/**
 * Build a session-gated `POST` handler that advances a device flow by one poll.
 *
 * The client drives the loop and honours the `interval` / `slow_down` pacing;
 * the server stays a single quick request so nothing blocks a route handler for
 * the fifteen minutes a device code can live.
 *
 * The ticket's DID must equal the caller's DID. That check is what stops a
 * ticket minted for one owner being redeemed into another owner's vault.
 */
export function createDevicePollHandler(opts: {
  pollDeviceTokenOnce(ownerDid: string, deviceCode: string): Promise<DevicePollStatus>;
  verifyDeviceTicket: DeviceTicketHelpers['verifyDeviceTicket'];
  connectorName: string;
}) {
  return async function POST(request: NextRequest) {
    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const ownerDid = resolveActingDid(auth.identity);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const ticket = typeof body.ticket === 'string' ? body.ticket : '';
    if (!ticket) {
      return NextResponse.json({ error: 'ticket is required' }, { status: 400 });
    }

    let deviceCode: string;
    try {
      const verified = opts.verifyDeviceTicket(ticket);
      if (verified.did !== ownerDid) {
        // Not 403-with-detail: the caller has no business learning whose ticket
        // this is, and the only honest thing left to say is "not yours".
        return NextResponse.json({ error: 'ticket does not belong to this identity' }, { status: 403 });
      }
      deviceCode = verified.deviceCode;
    } catch (err) {
      log.warn(
        { err: String(err), connector: opts.connectorName },
        `${opts.connectorName} device poll: invalid ticket`,
      );
      return NextResponse.json({ error: 'invalid or expired ticket' }, { status: 400 });
    }

    try {
      const status = await opts.pollDeviceTokenOnce(ownerDid, deviceCode);
      const payload: DevicePollResponse = { status };
      return NextResponse.json(payload);
    } catch (err) {
      return deviceFailure(opts.connectorName, err, 'poll');
    }
  };
}
