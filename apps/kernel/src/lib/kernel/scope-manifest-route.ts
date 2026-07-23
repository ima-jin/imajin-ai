/**
 * Shared connector scope-manifest route factory (#1396 registry / Sonar dedup fix).
 *
 * All four connector scope-manifest routes (GitHub, Discord, QuickBooks, MCP) share
 * identical GET + POST + OPTIONS boilerplate:
 *   - CORS pre-flight
 *   - requireAuth / resolveActingDid
 *   - GET: find manifest asset + read active scopes (+ optional credential booleans)
 *   - POST: parse body → validate scopes → publish → re-read active scopes
 *
 * This factory eliminates that duplication. Each connector's route file is now a
 * ~15-line wiring module that supplies connector-specific functions and is otherwise
 * indistinguishable from any future connector route.
 *
 * IMPORTANT: this file must remain client-safe (no node: imports, no DB, no vault)
 * so Next.js can tree-shake it correctly. All DB/vault work is in the passed-in fns.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';

const log = createLogger('kernel');

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal asset shape the factory needs from findManifestAsset. */
interface ManifestAsset { id: string }

export interface ConnectorRouteOpts {
  /**
   * Connector display name used in log messages and error strings,
   * e.g. `'GitHub'`, `'MCP'`. Keep it short.
   */
  name: string;
  /**
   * All scope strings accepted by POST. Unknown scopes are rejected 400
   * (fail-closed — no silent typo grants).
   */
  validScopes: readonly string[];
  /** Find the active scope-manifest asset for this owner, or null. */
  findManifestAsset: (ownerDid: string) => Promise<ManifestAsset | null>;
  /** Read active scopes from auth.channel_links for this owner. */
  readActiveScopes: (ownerDid: string) => Promise<string[]>;
  /**
   * Create or update the scope-manifest and fire document.changed.
   * Returns the stable asset id of the manifest document.
   */
  publish: (ownerDid: string, scopes: readonly string[]) => Promise<string>;
  /**
   * Optional extra fields appended to the GET response.
   *
   * OAuth connectors use this for credential-status booleans
   * (`configSealed`, `tokenSealed`). Native connectors omit it.
   *
   * Runs in parallel with findManifestAsset + readActiveScopes.
   */
  getExtraFields?: (ownerDid: string) => Promise<Record<string, unknown>>;
}

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export interface ConnectorRouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  OPTIONS: RouteHandler;
}

// ── CORS pre-flight (shared across all connector routes) ─────────────────────

/**
 * OPTIONS handler shared by every connector scope-manifest route.
 * Does not close over any factory state — defined at module scope so Sonar
 * does not flag it as a nested function that should be lifted.
 */
export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return corsOptions(request) as NextResponse;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build the GET + POST route handlers for a connector scope-manifest endpoint.
 * OPTIONS is exported separately at module scope and re-exported from each
 * connector's route file alongside these handlers:
 *
 * ```ts
 * export { OPTIONS } from '@/src/lib/kernel/scope-manifest-route';
 * export const { GET, POST } = createConnectorScopeManifestRoute({ … });
 * ```
 */
export function createConnectorScopeManifestRoute(
  opts: ConnectorRouteOpts,
): Omit<ConnectorRouteHandlers, 'OPTIONS'> {
  const validScopeSet = new Set<string>(opts.validScopes);

  // ── GET ────────────────────────────────────────────────────────────────────

  /**
   * Returns the current state of the connector for the session owner:
   *   - `manifestAssetId` — stable id of the scope-manifest asset (null = none).
   *   - `activeScopes`    — scopes currently active in auth.channel_links.
   *   - `validScopes`     — all scopes accepted by POST.
   *   - ...extra          — connector-specific credential booleans (optional).
   */
  async function GET(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const ownerDid = resolveActingDid(auth.identity);

    const [manifestAsset, activeScopes, extraFields] = await Promise.all([
      opts.findManifestAsset(ownerDid),
      opts.readActiveScopes(ownerDid),
      opts.getExtraFields ? opts.getExtraFields(ownerDid) : Promise.resolve({}),
    ]);

    return NextResponse.json(
      {
        manifestAssetId: manifestAsset?.id ?? null,
        activeScopes,
        validScopes: opts.validScopes,
        ...extraFields,
      },
      { headers: cors },
    );
  }

  // ── POST ───────────────────────────────────────────────────────────────────

  /**
   * Publish or update the scope-manifest for the session owner.
   *
   * Body: `{ "scopes": ["scope:name", …] }`
   *
   * Unknown scope names are rejected 400 (fail-closed).
   * An empty array revokes all scopes.
   */
  async function POST(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const ownerDid = resolveActingDid(auth.identity);

    let body: { scopes?: unknown };
    try {
      body = (await request.json()) as { scopes?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    if (!Array.isArray(body.scopes)) {
      return NextResponse.json(
        { error: 'scopes must be an array of scope strings' },
        { status: 400, headers: cors },
      );
    }

    const requestedScopes = body.scopes.filter((s): s is string => typeof s === 'string');
    const unknownScopes = requestedScopes.filter((s) => !validScopeSet.has(s));
    if (unknownScopes.length > 0) {
      return NextResponse.json(
        {
          error: `Unknown scope(s): ${unknownScopes.join(', ')}. Valid scopes: ${opts.validScopes.join(', ')}`,
        },
        { status: 400, headers: cors },
      );
    }

    let assetId: string;
    try {
      assetId = await opts.publish(ownerDid, requestedScopes);
    } catch (err) {
      log.error({ err: String(err), ownerDid }, `${opts.name} scope-manifest: publish failed`);
      return NextResponse.json(
        { error: `Failed to publish ${opts.name} scope manifest`, detail: String(err) },
        { status: 500, headers: cors },
      );
    }

    // Re-read active scopes after projection so the caller sees what actually
    // materialised (on-consent scopes may stay absent until consent_grants exist).
    const activeScopes = await opts.readActiveScopes(ownerDid);

    return NextResponse.json(
      { published: true, assetId, activeScopes },
      { status: 200, headers: cors },
    );
  }

  return { GET, POST };
}
