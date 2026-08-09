/**
 * Disconnect handler factory for **native** connectors (#1592).
 *
 * `createDisconnectHandler` in ./connector-oauth-routes is built around a
 * credential: it tombstones vault fields and then flips the grant row. A native
 * connector has no credential at all — the scope toggles ARE the connection — so
 * "disconnect" can only mean one thing: withdraw every scope the owner granted.
 *
 * That is deliberately expressed as a **publish of the empty scope set** rather
 * than a direct `UPDATE channel_links`. Grant-by-edit is the whole rail: the
 * manifest asset is the signed record of what was granted, and it must not be
 * left claiming scopes the DB says are revoked. Publishing an empty manifest
 * walks the same manifest → consent_grants → channel_links path a toggle does,
 * so the manifest, the consent rows, and the grant rows all end up agreeing.
 *
 * Three things the publish alone does not cover, and this factory does:
 *
 *   1. **Residual rows.** `publishConnectorScopeManifest` only revokes rows whose
 *      `channelUid` is prefixed with the manifest asset id. Rows written by an
 *      earlier manifest asset (or back-ported by #1222 before the current asset
 *      existed) would survive a publish and keep the connector live — the exact
 *      opposite of what the button promises. So the handler sweeps every
 *      remaining active row on the channel afterwards.
 *   2. **Dangling vault grants (#1720).** A native connector has no credential
 *      of its own, but this handler is generic and must not assume that stays
 *      true forever. It also sweeps any `kernel.vault_delegation_grants` rows
 *      matching `${connectorName}-*-key:${ownerDid}` — a no-op today for every
 *      current native connector, but it closes the same gap the sealed
 *      token-paste connectors had (see `connector-token-paste.ts`): revoking
 *      channel_links alone leaves a sealed key's wrapped material recoverable.
 *   3. **Honest failure.** The requirement is fail-closed: a revoke that only
 *      half-worked must say so rather than report success. The handler re-reads
 *      the active scopes at the end and returns 500 if anything survived, so the
 *      card keeps showing the grants that are genuinely still live.
 *
 * IMPORTANT: this file imports the DB, so it is server-only. It must not be
 * imported by the connector card or any other client component.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { revokeVaultDelegationGrantsForConnector } from '@/src/lib/vault';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';

const log = createLogger('kernel');

export interface NativeDisconnectOpts {
  /** Channel label in `auth.channel_links`, e.g. `'mcp'`. */
  channel: string;
  /** Connector app DID in `auth.channel_links`, e.g. `'did:imajin:mcp-connector'`. */
  connectorDid: string;
  /** Short connector name for the bus event payload and log lines, e.g. `'mcp'`. */
  connectorName: string;
  /**
   * Publish the connector's scope-manifest for this owner with the given scope
   * set. The handler always calls it with `[]` — it takes the scopes so the
   * connector can pass its existing publisher unchanged rather than growing a
   * second, revoke-only code path that could drift from the grant path.
   */
  publishScopeManifest: (ownerDid: string, scopes: readonly string[]) => Promise<string>;
  /** Read the scopes currently active in `auth.channel_links` for this owner. */
  readActiveScopes: (ownerDid: string) => Promise<string[]>;
}

/** JSON body returned by a native connector's disconnect route. */
export interface NativeDisconnectResponse {
  /** Always `false` on success — every scope grant is withdrawn. */
  connected: false;
  /** Post-revoke scope list. Empty on success; the card renders it verbatim. */
  activeScopes: string[];
  /** Stable id of the (now empty) scope-manifest asset. */
  manifestAssetId: string;
}

/**
 * Build the `POST` + `OPTIONS` handlers for a native connector's disconnect
 * route.
 *
 * Sequence (order matters — every step is idempotent):
 *   1. requireAuth → resolve the acting DID.
 *   2. Publish the scope-manifest with an empty scope set. A throw here is
 *      terminal: nothing has been revoked, so the grants are left exactly as
 *      they were and the caller gets the error.
 *   3. Sweep any active `channel_links` row still on the channel for this DID +
 *      connector, catching rows not anchored to the current manifest asset.
 *   4. Sweep any active `vault_delegation_grants` rows for this connector +
 *      DID (#1720). See the class doc above for why this matters.
 *   5. Re-read the active scopes. Anything left means the revoke did not take,
 *      and the response says so with a 500 rather than claiming success.
 *   6. Publish a `connector.disconnected` bus event for the audit trail
 *      (non-fatal — the grants are already gone).
 *
 * Usage (one-liner per connector):
 *   export const { POST, OPTIONS } = createNativeDisconnectHandler({ … });
 */
export function createNativeDisconnectHandler(opts: NativeDisconnectOpts) {
  async function OPTIONS(request: NextRequest): Promise<NextResponse> {
    return corsOptions(request) as NextResponse;
  }

  async function POST(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await requireAuth(request);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const ownerDid = resolveActingDid(auth.identity);

    // 1. Publish the cleared manifest. Fail-closed: if this throws, no grant has
    //    been touched, so the owner keeps exactly what they had.
    let manifestAssetId: string;
    try {
      manifestAssetId = await opts.publishScopeManifest(ownerDid, []);
    } catch (err) {
      log.error(
        { err: String(err), ownerDid },
        `${opts.connectorName} disconnect: cleared-manifest publish failed — grants left intact`,
      );
      return NextResponse.json(
        { error: `Failed to revoke ${opts.connectorName} grants`, detail: String(err) },
        { status: 500, headers: cors },
      );
    }

    // 2. Sweep residual rows the manifest publish could not reach (rows written
    //    against an older manifest asset id). No-op when there are none.
    try {
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
    } catch (err) {
      log.error(
        { err: String(err), ownerDid },
        `${opts.connectorName} disconnect: residual channel_links sweep failed`,
      );
      return NextResponse.json(
        { error: `Failed to revoke all ${opts.connectorName} grants`, detail: String(err) },
        { status: 500, headers: cors },
      );
    }

    // 3. Sweep dangling vault_delegation_grants rows for this connector + owner
    //    (#1720). No-op today for every current native connector, but a
    //    generic handler must not assume that stays true forever — see the
    //    class doc above.
    try {
      await revokeVaultDelegationGrantsForConnector(opts.connectorName, ownerDid);
    } catch (err) {
      log.error(
        { err: String(err), ownerDid },
        `${opts.connectorName} disconnect: vault delegation-grant sweep failed`,
      );
      return NextResponse.json(
        { error: `Failed to revoke all ${opts.connectorName} grants`, detail: String(err) },
        { status: 500, headers: cors },
      );
    }

    // 4. Verify. Reporting `connected: false` while a grant is still live would
    //    be the silent partial-clear this route exists to rule out.
    const activeScopes = await opts.readActiveScopes(ownerDid);
    if (activeScopes.length > 0) {
      log.error(
        { ownerDid, activeScopes },
        `${opts.connectorName} disconnect: scopes still active after revoke`,
      );
      return NextResponse.json(
        {
          error: `Some ${opts.connectorName} grants are still active after the revoke`,
          activeScopes,
        },
        { status: 500, headers: cors },
      );
    }

    // 5. Audit trail. Same topic and payload shape as the OAuth/token-paste
    //    disconnects so one subscriber covers every connector.
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
      log.error(
        { err: String(err), ownerDid },
        `${opts.connectorName} disconnect: bus publish failed (non-fatal)`,
      );
    });

    const body: NativeDisconnectResponse = { connected: false, activeScopes: [], manifestAssetId };
    return NextResponse.json(body, { headers: cors });
  }

  return { POST, OPTIONS };
}
