/**
 * Generic static-secret connector route factory (#1439).
 *
 * Provides GET / POST / DELETE / OPTIONS route handlers for a connector's
 * `/:connector/api/seal` endpoint. Parallel to createConnectorScopeManifestRoute
 * (#1396) — each connector's route file is a ~10-line wiring module:
 *
 * ```ts
 * export const { GET, POST, DELETE, OPTIONS } = createConnectorStaticSecretRoutes({
 *   name: 'Gemini',
 *   connector: geminiConnector,
 * });
 * ```
 *
 * Route semantics:
 *   GET    — `{ secretSealed: boolean, ...extraFields }` — credential status.
 *   POST   — body `{ secret, expiresAt? }` → seals + grants; `{ sealed: true }`.
 *   DELETE — revokes the delegation grant; `{ revoked: boolean }`.
 *
 * Security invariants:
 *   - The secret value is never logged, never returned, never echoed.
 *   - Sealed value is accessible only via server-side `loadAndUnsealByGrantee`.
 *   - Per-DID isolation: vault field encodes principalDid.
 *
 * IMPORTANT: this file must remain client-safe (no node: imports, no DB, no
 * vault) so Next.js can tree-shake it correctly. All DB/vault work is in the
 * passed-in ConnectorStaticSecret instance.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import type { ConnectorStaticSecret } from './connector-static-secret';

const log = createLogger('kernel');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConnectorStaticSecretRouteOpts {
  /**
   * Connector display name used in log messages and error strings,
   * e.g. `'Gemini'`, `'OpenAI'`. Keep it short.
   */
  name: string;
  /** The connector instance created by `createConnectorStaticSecret`. */
  connector: ConnectorStaticSecret;
  /**
   * Optional extra fields appended to the GET response.
   * Runs in parallel with `secretSealed`. Use for connector-specific metadata
   * (e.g. `{ modelId: '...' }` for a provider with optional overrides).
   */
  getExtraFields?: (principalDid: string) => Promise<Record<string, unknown>>;
}

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export interface ConnectorStaticSecretRouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  DELETE: RouteHandler;
  OPTIONS: RouteHandler;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build GET / POST / DELETE / OPTIONS Next.js route handlers for a static-
 * secret connector seal endpoint. Re-export the result directly:
 *
 * ```ts
 * export const { GET, POST, DELETE, OPTIONS } = createConnectorStaticSecretRoutes({ … });
 * ```
 */
export function createConnectorStaticSecretRoutes(
  opts: ConnectorStaticSecretRouteOpts,
): ConnectorStaticSecretRouteHandlers {

  // ── OPTIONS ──────────────────────────────────────────────────────────────

  async function OPTIONS(request: NextRequest): Promise<NextResponse> {
    return corsOptions(request) as NextResponse;
  }

  // ── GET ──────────────────────────────────────────────────────────────────

  /**
   * Returns the credential status for the session owner:
   *   - `secretSealed` — whether a secret is already sealed.
   *   - `...extraFields` — connector-specific metadata (optional).
   */
  async function GET(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const principalDid = resolveActingDid(auth.identity);

    const [secretSealed, extraFields] = await Promise.all([
      opts.connector.secretSealed(principalDid),
      opts.getExtraFields ? opts.getExtraFields(principalDid) : Promise.resolve({}),
    ]);

    return NextResponse.json({ secretSealed, ...extraFields }, { headers: cors });
  }

  // ── POST ─────────────────────────────────────────────────────────────────

  /**
   * Seal a static secret and mint a delegation grant for the connector app DID.
   *
   * Body: `{ "secret": "<plaintext>", "expiresAt"?: "<ISO-8601 string>" }`
   *
   * The secret must be non-empty. Re-posting supersedes the previous sealed
   * value (rotate semantics). The secret is never echoed back.
   */
  async function POST(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const principalDid = resolveActingDid(auth.identity);

    let body: { secret?: unknown; expiresAt?: unknown };
    try {
      body = (await request.json()) as { secret?: unknown; expiresAt?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    const secret = typeof body.secret === 'string' ? body.secret.trim() : null;
    if (!secret) {
      return NextResponse.json(
        { error: 'secret must be a non-empty string' },
        { status: 400, headers: cors },
      );
    }

    const expiresAt =
      typeof body.expiresAt === 'string'
        ? (() => {
            const d = new Date(body.expiresAt as string);
            return Number.isNaN(d.getTime()) ? null : d;
          })()
        : null;

    try {
      await opts.connector.sealAndGrant(principalDid, secret, { expiresAt });
      log.info({ principalDid }, `${opts.name} static secret sealed`);
    } catch (err) {
      log.error({ err: String(err), principalDid }, `${opts.name} static secret sealing failed`);
      return NextResponse.json(
        { error: `Failed to seal ${opts.name} secret`, detail: String(err) },
        { status: 500, headers: cors },
      );
    }

    return NextResponse.json({ sealed: true }, { status: 201, headers: cors });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────

  /**
   * Revoke the delegation grant for the session owner.
   *
   * Returns `{ revoked: true }` when a grant was deactivated, or
   * `{ revoked: false }` when no active grant existed for this principal.
   */
  async function DELETE(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const principalDid = resolveActingDid(auth.identity);

    let revoked: boolean;
    try {
      revoked = await opts.connector.revokeGrant(principalDid);
      log.info({ principalDid, revoked }, `${opts.name} static secret grant revocation attempted`);
    } catch (err) {
      log.error({ err: String(err), principalDid }, `${opts.name} static secret revocation failed`);
      return NextResponse.json(
        { error: `Failed to revoke ${opts.name} grant`, detail: String(err) },
        { status: 500, headers: cors },
      );
    }

    return NextResponse.json({ revoked }, { headers: cors });
  }

  return { GET, POST, DELETE, OPTIONS };
}
