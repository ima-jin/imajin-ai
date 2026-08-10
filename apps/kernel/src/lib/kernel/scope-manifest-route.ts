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
 * ownerDid resolution (#1756) goes through `resolveConnectorOwnerDid`, which
 * reads `registry.apps` when the request carries app-auth context so an
 * app-subsidized connection (#1624) resolves to the app owner's DID instead
 * of the logged-in user's. All other DB/vault work stays in the passed-in fns.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';

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
   *
   * A rejection here is contained, not fatal — see GET.
   */
  getExtraFields?: (ownerDid: string) => Promise<Record<string, unknown>>;
}

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export interface ConnectorRouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  OPTIONS: RouteHandler;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build the three Next.js route handlers for a connector scope-manifest
 * endpoint. The returned object is designed to be re-exported directly from
 * the connector's `app/.../scope-manifest/route.ts` file:
 *
 * ```ts
 * export const { GET, POST, OPTIONS } = createConnectorScopeManifestRoute({ … });
 * ```
 */
export function createConnectorScopeManifestRoute(
  opts: ConnectorRouteOpts,
): ConnectorRouteHandlers {
  const validScopeSet = new Set<string>(opts.validScopes);

  // ── OPTIONS ────────────────────────────────────────────────────────────────

  async function OPTIONS(request: NextRequest): Promise<NextResponse> {
    return corsOptions(request) as NextResponse;
  }

  // ── GET ────────────────────────────────────────────────────────────────────

  /**
   * Returns the current state of the connector for the session owner:
   *   - `manifestAssetId` — stable id of the scope-manifest asset (null = none).
   *   - `activeScopes`    — scopes currently active in auth.channel_links.
   *   - `validScopes`     — all scopes accepted by POST.
   *   - ...extra          — connector-specific credential booleans (optional).
   *   - `credentialStatusUnavailable` — present and true only when the
   *     credential probe failed (see below).
   *
   * This endpoint is what the connector card calls to render itself, including
   * its Disconnect button. If it 500s, the card shows "Unavailable" and the user
   * loses the very control they need to recover. So a failing credential probe
   * degrades to "no credential status" rather than failing the whole response:
   * the card falls back to its unconfigured state and Disconnect stays reachable.
   * The error is logged so the underlying fault is still visible.
   */
  async function GET(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const { ownerDid } = auth;

    async function readExtraFields(): Promise<Record<string, unknown>> {
      if (!opts.getExtraFields) {
        return {};
      }
      try {
        return await opts.getExtraFields(ownerDid);
      } catch (err) {
        log.error(
          { err: String(err), ownerDid },
          `${opts.name} scope-manifest: credential status probe failed — degrading response`,
        );
        return { credentialStatusUnavailable: true };
      }
    }

    const [manifestAsset, activeScopes, extraFields] = await Promise.all([
      opts.findManifestAsset(ownerDid),
      opts.readActiveScopes(ownerDid),
      readExtraFields(),
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

    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const { ownerDid } = auth;

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

  return { GET, POST, OPTIONS };
}
