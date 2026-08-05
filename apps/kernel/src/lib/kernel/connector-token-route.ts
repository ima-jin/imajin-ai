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
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';

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

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const ownerDid = resolveActingDid(auth.identity);

    return NextResponse.json({ keySealed: await opts.keySealed(ownerDid) }, { headers: cors });
  }

  /**
   * Seal an API key for the session owner. Re-posting replaces the previously
   * sealed key (rotate semantics).
   */
  async function POST(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const ownerDid = resolveActingDid(auth.identity);

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
