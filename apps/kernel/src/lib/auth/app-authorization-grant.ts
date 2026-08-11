/**
 * App-authorization → `auth.channel_links` projection (#1803, workstream 2/3).
 *
 * Direction (Ryan, #1803 rescope): apps do not get session-less reads of
 * consent-tier scopes (e.g. `supply:read`). Instead every app read falls
 * through the same two-gate selective-disclosure pattern MCP/GitHub connector
 * scopes already use (`apps/kernel/src/lib/mcp/mcp-grant.ts`,
 * `scope-projections.ts`):
 *
 *   OAuth/app token       → authentication (who is calling, which app)
 *   `channel_links` row   → authorization (what that app may read/write)
 *
 * No new consent surface: the OAuth authorize/consent screen the user already
 * completes at `POST /api/auth/authorize` IS the consent event. This module
 * only projects what was already granted there into a durable, per-supplier,
 * per-app, revocable `channel_links` row — it never prompts for anything.
 *
 * ── Seam for #1804 ──────────────────────────────────────────────────────────
 * #1804 (MCP: auto-publish a scope-manifest on first OAuth consent) is landing
 * the shared, connector-generic consent→publish→project helper in parallel,
 * for the MCP connector's own consent surface. That surface (and its owning
 * files, e.g. `mcp-grant.ts`) is explicitly out of scope here.
 *
 * This module is deliberately a thin, self-contained adapter directly over
 * `auth.channel_links` — it does not touch or duplicate any MCP-owned file —
 * so that once #1804's shared helper exists, the two call sites below
 * (`projectAppAuthorizationGrant` / `revokeAppAuthorizationGrant`) can be
 * replaced by a call into it without changing any caller
 * (`app/api/auth/authorize/route.ts`, `app/api/auth/revoke/route.ts`,
 * `src/lib/supply.ts`). Please don't grow this file with connector-specific
 * logic in the meantime — keep the seam thin.
 */
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';

/**
 * Channel used for app-authorization (OAuth consent) grants — distinct from
 * connector channels (`mcp`, `github`, ...) and messenger channels
 * (`telegram`, ...). One row per (ownerDid, appDid) pair: `channelUid` is the
 * granting owner's own DID, which is already unique per user, so it slots
 * cleanly into the existing `uniq_channel_links_pair (channel, channel_uid,
 * app_did)` index without colliding across users or apps.
 */
export const APP_AUTHORIZATION_CHANNEL = 'app' as const;

/**
 * Project a user's app-authorization consent (the granted scopes from
 * `POST /api/auth/authorize`) into an active `channel_links` row.
 *
 * Idempotent upsert keyed on (channel, channelUid, appDid): re-publishing
 * (e.g. re-consent) simply overwrites `scopes` to the latest granted set — a
 * scope dropped from a later consent is implicitly revoked because it no
 * longer appears in the array. Passing an empty `scopes` array revokes the
 * row outright (see `revokeAppAuthorizationGrant`).
 */
export async function projectAppAuthorizationGrant(opts: {
  ownerDid: string;
  appDid: string;
  scopes: readonly string[];
}): Promise<void> {
  const { ownerDid, appDid, scopes } = opts;

  if (scopes.length === 0) {
    await revokeAppAuthorizationGrant({ ownerDid, appDid });
    return;
  }

  await db
    .insert(channelLinks)
    .values({
      id: generateId('clink'),
      channel: APP_AUTHORIZATION_CHANNEL,
      channelUid: ownerDid,
      did: ownerDid,
      appDid,
      scopes: [...scopes],
      status: 'active',
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [channelLinks.channel, channelLinks.channelUid, channelLinks.appDid],
      set: { scopes: [...scopes], status: 'active', revokedAt: null },
    });
}

/**
 * Revoke a user's app-authorization grant (e.g. on full app disconnect via
 * `POST /api/auth/revoke`, or when a re-consent drops every scope). No-op if
 * no active row exists.
 */
export async function revokeAppAuthorizationGrant(opts: {
  ownerDid: string;
  appDid: string;
}): Promise<void> {
  const { ownerDid, appDid } = opts;

  await db
    .update(channelLinks)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(channelLinks.channel, APP_AUTHORIZATION_CHANNEL),
        eq(channelLinks.channelUid, ownerDid),
        eq(channelLinks.appDid, appDid),
        eq(channelLinks.status, 'active'),
      ),
    );
}

/**
 * True iff `appDid` holds an active app-authorization grant of `scope` from
 * `ownerDid` — the per-supplier enforcement check for #1803's item 3/5 (the
 * lot route checks this against `chain.lot.originatingDid`).
 *
 * Fail-closed: any DB error propagates as a thrown exception, same convention
 * as `resolveActiveMcpGrant`.
 */
export async function hasAppAuthorizationGrant(
  appDid: string,
  ownerDid: string,
  scope: string,
): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, APP_AUTHORIZATION_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, appDid),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(scope);
  });
}
