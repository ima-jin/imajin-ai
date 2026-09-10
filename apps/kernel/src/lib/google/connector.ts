/**
 * Google Workspace connector backend library (#2144, v1).
 *
 * Connects a human (or agent) DID's Google account via OAuth2
 * authorization-code with offline access, sealing the refresh token bundle in
 * the imajin vault, gated by an active `auth.channel_links` row for the
 * `google` connector app DID + the required `google:*` scope. `google_*` MCP
 * tools (added in a follow-up PR) act on behalf of the connecting DID —
 * modelled on `github/connector.ts` and reusing the same `createConnectorOAuth`
 * factory (#1333) GitHub and QuickBooks already use.
 *
 * No PATs, no service-account JSON, no app passwords — see the issue's
 * boundary section. One consent screen requests all six v1 Google API scopes
 * at once; the resulting single refresh token is what every `google:*` scope
 * below gates use of.
 *
 * ── Revocation, both directions (#2144) ──────────────────────────────────────
 * - Our revoke → Google: {@link revokeAtGoogle} POSTs the sealed refresh token
 *   (falling back to the access token) to Google's revoke endpoint. Called by
 *   the disconnect route BEFORE the shared vault-purge/grant-revoke handler.
 *   Best-effort — a provider-side failure must never block the owner's own
 *   revoke of their own credential.
 * - Google-side revoke → us: v1 ships the REACTIVE half only. Google answers a
 *   refresh attempt with `invalid_grant` once a user or Workspace admin
 *   revokes access from their side. {@link requireGrantAndToken} catches that,
 *   tombstones the `channel_links` grant + the `connectors` registry row,
 *   publishes `connector.disconnected`, and raises `google_credential_revoked`
 *   — the fail-closed behaviour the issue's "revoked grant" test exercises.
 *   The PROACTIVE half (catching a revoke before the next call, via Admin
 *   audit-log ingestion) needs the `google:admin:reports` scope, which the
 *   issue itself places in v2 (#2144) — not built here.
 *
 * Security invariants (same as every other OAuth connector in this repo):
 * - Fail-closed: no grant OR no sealed/valid credential ⇒ throw.
 * - The refresh token / access token are NEVER logged, NEVER returned to
 *   callers, NEVER echoed.
 * - Per-DID isolation: `google-config:${did}`, `google-oauth:${did}`.
 */
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, channelLinks } from '@/src/db';
import { revokeConnectorRegistration } from '../kernel/connector-registry-store';
import {
  createConnectorOAuth,
  ConnectorCredentialPendingError,
  type BaseOAuthConfig,
  type OAuthTokenResponse,
} from '../kernel/connector-oauth';
import { GOOGLE_CONNECTOR_DID } from './constants';

const log = createLogger('kernel');

export { GOOGLE_CONNECTOR_DID } from './constants';

/** Channel label in `auth.channel_links`. */
export const GOOGLE_CHANNEL = 'google';

/**
 * Google API scopes requested at authorize time, one per v1 imajin scope.
 * Order is cosmetic (space-joined into a single `scope` param) but kept
 * parallel to the imajin scope list for readability.
 */
export const GOOGLE_OAUTH_SCOPES: Readonly<Record<string, string>> = {
  'google:gmail:read': 'https://www.googleapis.com/auth/gmail.readonly',
  'google:gmail:send': 'https://www.googleapis.com/auth/gmail.send',
  'google:calendar:read': 'https://www.googleapis.com/auth/calendar.readonly',
  'google:calendar:write': 'https://www.googleapis.com/auth/calendar.events',
  'google:drive:read': 'https://www.googleapis.com/auth/drive.readonly',
  'google:meet:records': 'https://www.googleapis.com/auth/meetings.space.readonly',
};

const GOOGLE_OAUTH_SCOPE = Object.values(GOOGLE_OAUTH_SCOPES).join(' ');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// ── Google-specific types ────────────────────────────────────────────────────

/** Google OAuth app config — always the owner's own OAuth client (BYO-app). */
export type GoogleConfig = BaseOAuthConfig;

export interface GoogleTokens {
  accessToken: string;
  /**
   * Present after the first `prompt=consent` exchange; Google omits it on
   * later refreshes, so it is always carried forward from the previous bundle.
   */
  refreshToken?: string;
  scope?: string;
  /** epoch ms at which the access token expires. */
  expiresAt: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────

const google = createConnectorOAuth<GoogleConfig, GoogleTokens>({
  name: 'google',
  configPrefix: 'google-config',
  tokenPrefix: 'google-oauth',
  connectorDid: GOOGLE_CONNECTOR_DID,
  channel: GOOGLE_CHANNEL,
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: GOOGLE_TOKEN_URL,
  oauthScope: GOOGLE_OAUTH_SCOPE,
  // Google accepts client credentials in the token-endpoint body.
  tokenAuth: 'body',
  // access_type=offline is what makes Google issue a refresh_token at all;
  // prompt=consent forces the consent screen (and therefore a fresh
  // refresh_token) on every authorize, instead of only the very first one —
  // without it, a re-connect after a revoke would silently fail to seal a
  // usable refresh token.
  extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
  parseConfig: (raw) => raw as GoogleConfig,
  buildTokens: (data: OAuthTokenResponse, _extra, previous) => ({
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string | undefined) ?? previous?.refreshToken,
    scope: (data.scope as string | undefined) ?? previous?.scope,
    expiresAt: Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
  }),
  // Google access tokens always expire (typically in 1hr); refresh 60s ahead.
  shouldRefresh: (tokens) => Date.now() >= tokens.expiresAt - 60_000,
});

// ── Public exports (shared interface) ────────────────────────────────────────

export const configField = google.configField;
export const oauthVaultField = google.tokenField;
export const storeConfig = google.storeConfig;
export const buildAuthorizeUrl = google.buildAuthorizeUrl;
export const exchangeCodeAndStore = google.exchangeCodeAndStore;
export const resolveActiveGrant = google.resolveActiveGrant;

/**
 * Which BYO-app flow the owner's sealed config is for, or null when nothing
 * is sealed yet (or the config is sealed behind a pending delegation grant).
 * Google only ever supports authorization-code (it has no RFC 8628 device
 * endpoint), but this stays symmetrical with the other OAuth connectors so
 * the shared scope-manifest route can report a `flow` field uniformly.
 */
export async function readConfigFlow(ownerDid: string): Promise<'authorization_code' | null> {
  try {
    await google.loadConfig(ownerDid);
    return 'authorization_code';
  } catch (err) {
    if (err instanceof ConnectorCredentialPendingError) return null;
    if (err instanceof Error && err.message.startsWith('google_no_config')) return null;
    throw err;
  }
}

/**
 * List every owner DID with an ACTIVE `channel_links` row for the Google
 * connector that includes `requiredScope` — the reverse of
 * `resolveActiveGrant`, used by the Gmail watch-renewal cron sweep.
 */
export async function listActiveGrantOwners(requiredScope: string): Promise<string[]> {
  const rows = await db
    .select({ did: channelLinks.did, scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, GOOGLE_CHANNEL),
        eq(channelLinks.appDid, GOOGLE_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );
  const owners = new Set<string>();
  for (const row of rows) {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    if (scopes.includes(requiredScope)) owners.add(row.did);
  }
  return [...owners];
}

// ── Google-side revoke detection (reactive half, #2144) ──────────────────────

/** True when a thrown error is Google's `invalid_grant` token-endpoint response. */
function isInvalidGrantError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('invalid_grant');
}

/**
 * Tombstone the Google grant for `ownerDid` after detecting a Google-side
 * revoke: revoke the active `channel_links` row(s), mirror the revocation
 * into the `connectors` registry, and publish `connector.disconnected`.
 *
 * Best-effort on the bookkeeping — a failure here must not stop the caller
 * from still seeing (and honouring) `google_credential_revoked`.
 */
async function tombstoneOnDetectedRevoke(ownerDid: string): Promise<void> {
  try {
    await db
      .update(channelLinks)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        and(
          eq(channelLinks.channel, GOOGLE_CHANNEL),
          eq(channelLinks.did, ownerDid),
          eq(channelLinks.appDid, GOOGLE_CONNECTOR_DID),
          eq(channelLinks.status, 'active'),
        ),
      );
    await revokeConnectorRegistration(ownerDid, 'google');
    await publish('connector.disconnected', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: GOOGLE_CHANNEL,
      payload: {
        ownerDid,
        connector: 'google',
        context_id: ownerDid,
        context_type: 'google',
      },
    });
  } catch (err) {
    log.error(
      { err: String(err), ownerDid },
      'google: tombstone-on-detected-revoke bookkeeping failed (non-fatal)',
    );
  }
}

/**
 * Resolve the connector grant and a usable, fresh access token. Fail-closed.
 *
 * Throws:
 *   - `google_no_grant`         — no active channel_links row for ownerDid + scope.
 *   - `google_no_credential`    — no sealed OAuth bundle at all.
 *   - `google_credential_pending` — sealed but awaiting owner grant approval.
 *   - `google_credential_revoked` — Google rejected the refresh with
 *     `invalid_grant` (the owner or a Workspace admin revoked access on
 *     Google's side). The grant is tombstoned as part of raising this.
 */
export async function requireGrantAndToken(ownerDid: string, scope: string): Promise<string> {
  const hasGrant = await google.resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `google_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `edit the scope-manifest to enable this connector scope`,
    );
  }

  let accessToken: string | undefined;
  try {
    accessToken = await google.loadAccessToken(ownerDid);
  } catch (err) {
    if (err instanceof ConnectorCredentialPendingError) {
      throw new Error(
        `google_credential_pending: Google OAuth bundle for DID ${ownerDid} is sealed but awaiting owner grant approval`,
      );
    }
    if (isInvalidGrantError(err)) {
      await tombstoneOnDetectedRevoke(ownerDid);
      throw new Error(
        `google_credential_revoked: Google rejected the refresh token for DID ${ownerDid} ` +
        `(revoked on Google's side) — the grant has been tombstoned; reconnect via /google/api/connect`,
      );
    }
    throw err;
  }

  if (accessToken === undefined) {
    throw new Error(
      `google_no_credential: no Google OAuth token sealed for DID ${ownerDid} — ` +
      `authorize via /google/api/connect first`,
    );
  }
  return accessToken;
}

// ── Provider-side revoke (our revoke → Google, #2144) ────────────────────────

/**
 * Best-effort: revoke the sealed Google OAuth grant at Google's own revoke
 * endpoint. Revoking either token revokes the whole grant (RFC 7009 semantics
 * as implemented by Google) — the refresh token is preferred since revoking it
 * also invalidates every access token issued from it.
 *
 * Deliberately non-fatal: a provider-side outage or an already-revoked token
 * must never block the owner's own disconnect (which still purges the vault
 * and revokes the local grant regardless of this call's outcome).
 */
export async function revokeAtGoogle(ownerDid: string): Promise<void> {
  let tokens: GoogleTokens | undefined;
  try {
    tokens = await google.loadTokens(ownerDid);
  } catch (err) {
    log.warn({ err: String(err), ownerDid }, 'google disconnect: could not load tokens to revoke (non-fatal)');
    return;
  }
  if (tokens === undefined) return;

  const tokenToRevoke = tokens.refreshToken ?? tokens.accessToken;
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenToRevoke }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn(
        { ownerDid, status: res.status, body: text },
        'google disconnect: provider-side revoke returned non-2xx (non-fatal)',
      );
      return;
    }
    log.info({ ownerDid }, 'google disconnect: provider-side token revoked');
  } catch (err) {
    log.warn({ err: String(err), ownerDid }, 'google disconnect: provider-side revoke request failed (non-fatal)');
  }
}
