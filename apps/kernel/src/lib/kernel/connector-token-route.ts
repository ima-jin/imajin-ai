/**
 * Shared token-paste credential route factory (#1621).
 *
 * Pattern B credential ingestion: the owner pastes a provider API key and it is
 * sealed per-DID, without the key ever passing through a chat client. Gemini
 * (#1432) and Anthropic (#1621) need byte-identical handlers, so the shape is
 * declared once here — the same move `createConnectorScopeManifestRoute` made for
 * scope-manifest routes.
 *
 *   GET  → `{ keySealed: boolean }`. An existence check, never the key.
 *   POST → seals `{ token, baseUrl?, modelId? }`. `token` is the API key; a
 *          sealed `modelId` is how the owner picks which model runs.
 *
 * Security invariants:
 *   - The key is never logged, never returned, never echoed.
 *   - A sealing failure reports THAT it failed, not why: an upstream error can
 *     embed the value being sealed, so the cause is logged server-side only.
 *   - Per-DID isolation comes from the connector's vault field naming.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';

const log = createLogger('kernel');

export interface ConnectorTokenRouteOpts {
  /** Display name used in log lines and the failure message, e.g. `'Gemini'`. */
  name: string;
  /** Seal the pasted credential for this DID. */
  sealApiKey: (ownerDid: string, apiKey: string, baseUrl?: string, modelId?: string) => Promise<void>;
  /** Whether a key is already sealed for this DID. */
  keySealed: (ownerDid: string) => Promise<boolean>;
}

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export interface ConnectorTokenRouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  OPTIONS: RouteHandler;
}

/** Optional trimmed string, or undefined when absent or blank. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the three handlers for a token-paste credential endpoint. Designed to be
 * re-exported straight from the connector's route file:
 *
 * ```ts
 * export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({ … });
 * ```
 */
export function createConnectorTokenRoutes(
  opts: ConnectorTokenRouteOpts,
): ConnectorTokenRouteHandlers {

  async function OPTIONS(request: NextRequest): Promise<NextResponse> {
    return corsOptions(request) as NextResponse;
  }

  /** Returns `{ keySealed }` — whether a key is already sealed for the owner. */
  async function GET(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const { ownerDid } = auth;

    return NextResponse.json({ keySealed: await opts.keySealed(ownerDid) }, { headers: cors });
  }

  /**
   * Seal an API key for the session owner. Re-posting replaces the previously
   * sealed key (rotate semantics).
   */
  async function POST(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const { ownerDid } = auth;

    let body: { token?: unknown; baseUrl?: unknown; modelId?: unknown };
    try {
      body = (await request.json()) as { token?: unknown; baseUrl?: unknown; modelId?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    const token = optionalString(body.token);
    if (!token) {
      return NextResponse.json(
        { error: 'token must be a non-empty string' },
        { status: 400, headers: cors },
      );
    }

    try {
      await opts.sealApiKey(ownerDid, token, optionalString(body.baseUrl), optionalString(body.modelId));
      log.info({ ownerDid }, `${opts.name} API key sealed`);
    } catch (err) {
      log.error({ err: String(err), ownerDid }, `${opts.name} API key sealing failed`);
      return NextResponse.json(
        { error: `Failed to seal ${opts.name} API key` },
        { status: 500, headers: cors },
      );
    }

    return NextResponse.json({ sealed: true }, { status: 201, headers: cors });
  }

  return { GET, POST, OPTIONS };
}

// ── Disconnect (#1720) ────────────────────────────────────────────────────────────

export interface ConnectorTokenDisconnectRouteOpts {
  /** Display name used in log lines and the failure message, e.g. `'Gemini'`. */
  name: string;
  /**
   * Revoke the sealed API key's delegation grant for this DID, and every
   * active `channel_links` row for this connector + DID (#1733).
   */
  revokeApiKey: (ownerDid: string) => Promise<boolean>;
}

export interface ConnectorTokenDisconnectRouteHandlers {
  POST: RouteHandler;
  OPTIONS: RouteHandler;
}

/**
 * Build the `POST` + `OPTIONS` handlers for a token-paste connector's
 * disconnect route (#1720).
 *
 * Unlike the OAuth/native disconnect handlers, this does not tombstone the
 * sealed vault field — `opts.revokeApiKey` (see `createConnectorTokenPaste`)
 * revokes the sealed key's delegation grant AND every active `channel_links`
 * row for the connector + DID (#1733), mirroring the static-secret
 * connector's DELETE semantics for the vault grant (see
 * `connector-static-secret-route.ts`) while still closing the same
 * channel_links gap the native disconnect handler already closed. The
 * dispatch verb differs (`disconnectMethod` in `connector-card-kind.ts`
 * routes token-paste connectors to a dedicated POST route rather than
 * overloading the seal route's DELETE) but the underlying revoke is the same
 * idea: kill access without discarding the recoverable secret.
 *
 * Usage:
 *   export const { POST, OPTIONS } = createConnectorTokenDisconnectRoute({ … });
 */
export function createConnectorTokenDisconnectRoute(
  opts: ConnectorTokenDisconnectRouteOpts,
): ConnectorTokenDisconnectRouteHandlers {

  async function OPTIONS(request: NextRequest): Promise<NextResponse> {
    return corsOptions(request) as NextResponse;
  }

  async function POST(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const { ownerDid } = auth;

    let revoked: boolean;
    try {
      revoked = await opts.revokeApiKey(ownerDid);
      log.info({ ownerDid, revoked }, `${opts.name} API key grant revocation attempted`);
    } catch (err) {
      log.error({ err: String(err), ownerDid }, `${opts.name} API key revocation failed`);
      return NextResponse.json(
        { error: `Failed to revoke ${opts.name} API key`, detail: String(err) },
        { status: 500, headers: cors },
      );
    }

    return NextResponse.json({ connected: false, revoked }, { headers: cors });
  }

  return { POST, OPTIONS };
}
