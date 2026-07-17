/**
 * Shared Next.js App Router handler factories for OAuth connector routes (#1333).
 *
 * Every connector needs the same three routes: connect (start authorize redirect),
 * callback (exchange code + seal tokens), and configure (seal per-DID app config).
 * The bodies were identical or near-identical across connectors. This file
 * centralises them so each route file is a thin 4–8 line delegation.
 *
 * Exports:
 *   createConnectHandler   — GET: requireAuth → buildAuthorizeUrl → redirect
 *   createCallbackHandler  — GET: verifyState → exchange → { connected: true }
 *   MissingCallbackParamError — throw inside `exchange` to return 400 (not 502)
 *   createConfigureHandler — OPTIONS + POST: auth → validate → storeConfig
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import type { BaseOAuthConfig } from './connector-oauth';

const log = createLogger('kernel');

// ── Connect ───────────────────────────────────────────────────────────────────

/**
 * Build a session-gated `GET` handler that starts the OAuth2 authorize redirect.
 * The caller supplies the connector's `buildAuthorizeUrl` and `signState` so
 * the handler has no knowledge of the specific provider.
 */
export function createConnectHandler(
  buildAuthorizeUrl: (ownerDid: string, state: string) => Promise<string>,
  signState: (ownerDid: string) => string,
) {
  return async function GET(request: NextRequest) {
    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    const ownerDid = resolveActingDid(auth.identity);
    return NextResponse.redirect(await buildAuthorizeUrl(ownerDid, signState(ownerDid)));
  };
}

// ── Callback ──────────────────────────────────────────────────────────────────

/**
 * Throw inside `exchange` when a required provider-specific callback param
 * (e.g. Intuit's `realmId`) is absent. The handler returns 400 instead of 502.
 */
export class MissingCallbackParamError extends Error {
  constructor(param: string) {
    super(`Missing ${param}`);
  }
}

/**
 * Build a `GET` handler for the OAuth2 callback route. The callback arrives
 * without an imajin session; the signed `state` authenticates the owner DID.
 *
 * `exchange` receives the verified `ownerDid`, `code`, and the raw
 * `URLSearchParams` so callers can extract provider-specific params (e.g.
 * Intuit's `realmId`). Throw `MissingCallbackParamError` to map to 400.
 */
export function createCallbackHandler(opts: {
  verifyState(state: string): string;
  exchange(ownerDid: string, code: string, searchParams: URLSearchParams): Promise<void>;
  connectorName: string;
}) {
  return async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code || !state) {
      return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
    }

    let ownerDid: string;
    try {
      ownerDid = opts.verifyState(state);
    } catch (err) {
      log.warn({ err: String(err) }, `${opts.connectorName} callback: invalid state`);
      return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 });
    }

    try {
      await opts.exchange(ownerDid, code, searchParams);
    } catch (err) {
      if (err instanceof MissingCallbackParamError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      log.error({ err: String(err), ownerDid }, `${opts.connectorName} callback: token exchange failed`);
      return NextResponse.json({ error: `${opts.connectorName} connection failed` }, { status: 502 });
    }

    return NextResponse.json({ connected: true });
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
