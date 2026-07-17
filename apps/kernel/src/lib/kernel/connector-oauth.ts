/**
 * Generic OAuth2 authorization-code connector factory (#1333).
 *
 * Encapsulates the six pieces of boilerplate that every connector repeats:
 *   1. Per-DID config sealing (configField / storeConfig / loadConfig)
 *   2. Per-DID token bundle sealing (tokenField / storeTokens / loadTokens)
 *   3. Token-endpoint POST (HTTP Basic or body-param credentials, error detection)
 *   4. Authorize-URL construction
 *   5. Code exchange + token refresh
 *   6. channel_links grant resolution
 *
 * Usage:
 *   const connector = createConnectorOAuth<MyConfig, MyTokens>({ ... });
 *   export const configField     = connector.configField;
 *   export const buildAuthorizeUrl = connector.buildAuthorizeUrl;
 *   // … etc.
 *
 * Provider-specific shape (token bundle fields, shouldRefresh predicate,
 * token-endpoint auth method, extra callback params like realmId) is supplied
 * via the options object. Provider-specific API actions stay in the connector.
 */
import { createLogger } from '@imajin/logger';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStore, loadAndUnseal } from '@/src/lib/vault';

const log = createLogger('kernel');

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimum shape every connector config must satisfy. */
export interface BaseOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Normalized token-endpoint response. Providers may add extra fields (e.g.
 * `scope`, `realm_id`) — the index signature carries those through to
 * `buildTokens` so callers can read them without casting.
 */
export interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

/** Options that parameterize the factory for a specific OAuth provider. */
export interface ConnectorOAuthOptions<
  TConfig extends BaseOAuthConfig,
  TTokens extends { accessToken: string; refreshToken?: string },
> {
  /**
   * Short connector name used in error messages and log output, e.g.
   * `'github'`, `'quickbooks'`.
   */
  name: string;
  /**
   * Vault key prefix for the per-DID OAuth app config,
   * e.g. `'github-config'`. The full key is `${configPrefix}:${ownerDid}`.
   */
  configPrefix: string;
  /**
   * Vault key prefix for the per-DID token bundle,
   * e.g. `'github-oauth'`. The full key is `${tokenPrefix}:${ownerDid}`.
   */
  tokenPrefix: string;
  /** Connector DID that appears in channel_links rows, e.g. `'did:imajin:github-connector'`. */
  connectorDid: string;
  /** Channel name in channel_links rows, e.g. `'github'`. */
  channel: string;
  /** OAuth2 authorize endpoint URL. */
  authorizeUrl: string;
  /** OAuth2 token endpoint URL. */
  tokenUrl: string;
  /** OAuth scope string requested at authorize time (provider-specific, not imajin channel scope). */
  oauthScope: string;
  /**
   * How client credentials are sent to the token endpoint:
   * - `'basic'` — HTTP `Authorization: Basic base64(clientId:clientSecret)` header (e.g. Intuit).
   * - `'body'`  — `client_id` + `client_secret` in the URL-encoded request body (e.g. GitHub).
   */
  tokenAuth: 'basic' | 'body';
  /**
   * Parse a raw JSON value (from the vault) into a typed config. Throw on
   * invalid input; a simple cast is fine when the configure route validates.
   */
  parseConfig(raw: unknown): TConfig;
  /**
   * Build a token bundle from a token-endpoint response.
   * - `extra` carries callback-specific params (e.g. `{ realmId: '...' }` for Intuit).
   * - `previous` is the prior sealed bundle, if any, for field carry-forward
   *   (e.g. keeping `realmId` across refreshes).
   */
  buildTokens(
    response: OAuthTokenResponse,
    extra: Record<string, unknown>,
    previous: TTokens | undefined,
  ): TTokens;
  /**
   * Return true when the sealed access token should be refreshed before use.
   * The implementation decides the exact policy (e.g. check `expiresAt`,
   * check `refreshToken` presence, etc.).
   */
  shouldRefresh(tokens: TTokens): boolean;
}

/** The object returned by `createConnectorOAuth`. */
export interface ConnectorOAuth<
  TConfig extends BaseOAuthConfig,
  TTokens extends { accessToken: string; refreshToken?: string },
> {
  /** Vault key for the per-DID config. */
  configField(ownerDid: string): string;
  /** Vault key for the per-DID token bundle. */
  tokenField(ownerDid: string): string;
  /** Seal a config in the vault. */
  storeConfig(ownerDid: string, config: TConfig): Promise<void>;
  /** Load and parse the sealed config; throws `${name}_no_config` if absent. */
  loadConfig(ownerDid: string): Promise<TConfig>;
  /** Seal a token bundle in the vault. */
  storeTokens(ownerDid: string, tokens: TTokens): Promise<void>;
  /** Load the sealed token bundle; returns undefined if none exists. */
  loadTokens(ownerDid: string): Promise<TTokens | undefined>;
  /**
   * Load the token bundle, refreshing it first (via `shouldRefresh`) when
   * necessary. Returns undefined if no bundle is sealed. Re-seals the
   * refreshed bundle automatically.
   */
  loadAndRefreshTokens(ownerDid: string): Promise<TTokens | undefined>;
  /**
   * Convenience wrapper: `loadAndRefreshTokens` → returns `.accessToken`, or
   * undefined when no bundle is sealed. Use this for the OAuth-first gate.
   */
  loadAccessToken(ownerDid: string): Promise<string | undefined>;
  /** Build the provider authorize redirect URL using the DID's sealed config. */
  buildAuthorizeUrl(ownerDid: string, state: string): Promise<string>;
  /**
   * Exchange an authorization code for tokens, seal the bundle, and log.
   * `extra` carries any callback-only params (e.g. `{ realmId }` for Intuit).
   */
  exchangeCodeAndStore(ownerDid: string, code: string, extra?: Record<string, unknown>): Promise<void>;
  /**
   * Resolve whether an ACTIVE channel_links row for ownerDid + scope exists.
   * Fail-closed: DB errors propagate.
   */
  resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createConnectorOAuth<
  TConfig extends BaseOAuthConfig,
  TTokens extends { accessToken: string; refreshToken?: string },
>(opts: ConnectorOAuthOptions<TConfig, TTokens>): ConnectorOAuth<TConfig, TTokens> {

  function configField(ownerDid: string): string {
    return `${opts.configPrefix}:${ownerDid}`;
  }

  function tokenField(ownerDid: string): string {
    return `${opts.tokenPrefix}:${ownerDid}`;
  }

  async function storeConfig(ownerDid: string, config: TConfig): Promise<void> {
    await sealAndStore(configField(ownerDid), JSON.stringify(config));
  }

  async function loadConfig(ownerDid: string): Promise<TConfig> {
    const raw = await loadAndUnseal(configField(ownerDid));
    if (raw === undefined) {
      throw new Error(`${opts.name}_no_config: DID ${ownerDid} has not configured a ${opts.name} connection`);
    }
    return opts.parseConfig(JSON.parse(raw));
  }

  async function storeTokens(ownerDid: string, tokens: TTokens): Promise<void> {
    await sealAndStore(tokenField(ownerDid), JSON.stringify(tokens));
  }

  async function loadTokens(ownerDid: string): Promise<TTokens | undefined> {
    const raw = await loadAndUnseal(tokenField(ownerDid));
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as TTokens;
  }

  async function postToken(config: TConfig, body: URLSearchParams): Promise<OAuthTokenResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (opts.tokenAuth === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_id', config.clientId);
      body.set('client_secret', config.clientSecret);
    }
    const res = await fetch(opts.tokenUrl, { method: 'POST', headers, body: body.toString() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${opts.name}_token: token endpoint ${res.status} ${res.statusText}: ${text}`);
    }
    const data = (await res.json()) as OAuthTokenResponse;
    if (data.error || !data.access_token) {
      throw new Error(`${opts.name}_token: ${data.error ?? 'no access_token'}: ${data.error_description ?? ''}`.trimEnd());
    }
    return data;
  }

  async function refreshBundle(ownerDid: string, config: TConfig, tokens: TTokens): Promise<TTokens> {
    const rt = tokens.refreshToken;
    if (!rt) {
      throw new Error(`${opts.name}_refresh: no refresh token available for DID ${ownerDid}`);
    }
    const data = await postToken(config, new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
    }));
    const refreshed = opts.buildTokens(data, {}, tokens);
    await storeTokens(ownerDid, refreshed);
    return refreshed;
  }

  async function loadAndRefreshTokens(ownerDid: string): Promise<TTokens | undefined> {
    const tokens = await loadTokens(ownerDid);
    if (tokens === undefined) return undefined;
    if (opts.shouldRefresh(tokens)) {
      const config = await loadConfig(ownerDid);
      return refreshBundle(ownerDid, config, tokens);
    }
    return tokens;
  }

  async function loadAccessToken(ownerDid: string): Promise<string | undefined> {
    const tokens = await loadAndRefreshTokens(ownerDid);
    return tokens?.accessToken;
  }

  async function buildAuthorizeUrl(ownerDid: string, state: string): Promise<string> {
    const config = await loadConfig(ownerDid);
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      scope: opts.oauthScope,
      redirect_uri: config.redirectUri,
      state,
    });
    return `${opts.authorizeUrl}?${params.toString()}`;
  }

  async function exchangeCodeAndStore(
    ownerDid: string,
    code: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const config = await loadConfig(ownerDid);
    const data = await postToken(config, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    }));
    await storeTokens(ownerDid, opts.buildTokens(data, extra, undefined));
    log.info({ ownerDid }, `${opts.name} account connected via OAuth`);
  }

  async function resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean> {
    const rows = await db
      .select({ scopes: channelLinks.scopes })
      .from(channelLinks)
      .where(
        and(
          eq(channelLinks.channel, opts.channel),
          eq(channelLinks.did, ownerDid),
          eq(channelLinks.appDid, opts.connectorDid),
          eq(channelLinks.status, 'active'),
        ),
      );
    return rows.some((row) => {
      const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
      return scopes.includes(requiredScope);
    });
  }

  return {
    configField,
    tokenField,
    storeConfig,
    loadConfig,
    storeTokens,
    loadTokens,
    loadAndRefreshTokens,
    loadAccessToken,
    buildAuthorizeUrl,
    exchangeCodeAndStore,
    resolveActiveGrant,
  };
}
