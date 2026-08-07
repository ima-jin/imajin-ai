/**
 * Generic OAuth2 connector factory (#1333; device flow #1391).
 *
 * Encapsulates the boilerplate that every connector repeats:
 *   1. Per-DID config sealing (configField / storeConfig / loadConfig)
 *   2. Per-DID token bundle sealing (tokenField / storeTokens / loadTokens)
 *   3. Token-endpoint POST (HTTP Basic or body-param credentials, error detection)
 *   4. Authorize-URL construction
 *   5. Code exchange + token refresh
 *   6. channel_links grant resolution
 *   7. RFC 8628 device authorization grant (opt-in per connector)
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
 *
 * ── Two BYO auth paths (#1391) ───────────────────────────────────────────────
 * A connector config is one of two shapes, discriminated by `flow`:
 *
 *   'authorization_code' — clientId + clientSecret + redirectUri. Browser
 *                          redirect to the provider, code exchanged at the
 *                          callback route.
 *   'device'             — clientId ONLY. No secret, no callback URL. The
 *                          server asks the provider for a device code, the
 *                          human types the user code at the provider's
 *                          verification page, and the server polls the token
 *                          endpoint until the grant lands.
 *
 * Both are bring-your-own-app: the OAuth App is always registered by the owner,
 * never a shared imajin-held credential (see #1391 for the reasoning). Device
 * flow is preferred only because it strips the two friction points (secret +
 * byte-exact callback), not because custody differs — the resulting token is
 * sealed per-DID identically either way.
 */
import { createLogger } from '@imajin/logger';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStoreV2, loadAndUnseal } from '@/src/lib/vault';
import { VaultDelegationError } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/**
 * Thrown by `loadConfig` / `loadTokens` when the vault entry exists but is
 * sealed under a delegation grant that has not arrived yet (Tier 1, owner
 * agent hasn't responded). Distinct from `${name}_no_config` (nothing sealed
 * at all) so callers — and the HTTP routes wrapping them — can render
 * "waiting for owner approval" instead of treating the field as unconfigured,
 * or letting a raw VaultDelegationError surface as an opaque 500.
 */
export class ConnectorCredentialPendingError extends Error {
  constructor(connectorName: string, field: string) {
    super(
      `${connectorName}_credential_pending: credential sealed at '${field}' is awaiting owner grant approval`,
    );
    this.name = 'ConnectorCredentialPendingError';
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Which OAuth2 grant a sealed connector config is for (#1391).
 *
 * Not a cosmetic label: it decides which fields must be present, which routes
 * are reachable, and which grant_type the token endpoint is called with.
 */
export type OAuthFlow = 'device' | 'authorization_code';

/**
 * Minimum shape every connector config must satisfy.
 *
 * `clientSecret` / `redirectUri` are optional because a device-flow config
 * legitimately has neither (#1391) — a BYO device-flow app is a client_id and
 * nothing else. Authorization-code paths assert their presence at use time via
 * {@link requireAuthCodeConfig} rather than in the type, so one sealed-config
 * shape can serve both flows.
 */
export interface BaseOAuthConfig {
  clientId: string;
  /** Authorization-code only. Absent in device flow. */
  clientSecret?: string;
  /** Authorization-code only. Absent in device flow. */
  redirectUri?: string;
  /**
   * Explicit grant discriminator. Absent on configs sealed before #1391, which
   * {@link resolveOAuthFlow} reads as authorization-code when the secret and
   * redirect URI are both present.
   */
  flow?: OAuthFlow;
}

/**
 * Resolve the effective flow for a config.
 *
 * An explicit `flow` always wins. Otherwise a config carrying both a secret and
 * a redirect URI is authorization-code (this is every config sealed before
 * #1391, so they keep working untouched); anything else is device mode, which
 * matches the "clientId only ⇒ device" default the issue asks for.
 */
export function resolveOAuthFlow(config: Readonly<BaseOAuthConfig>): OAuthFlow {
  if (config.flow !== undefined) return config.flow;
  return config.clientSecret && config.redirectUri ? 'authorization_code' : 'device';
}

/**
 * Authorization-code view of a config: the two optional fields proven present.
 * Produced only by {@link requireAuthCodeConfig}.
 */
type AuthCodeConfig<TConfig extends BaseOAuthConfig> = TConfig & {
  clientSecret: string;
  redirectUri: string;
};

/**
 * Narrow a config to the authorization-code shape, or throw.
 *
 * Fail-closed on purpose: a device-mode config reaching an authorization-code
 * entry point means the caller wired the wrong route, and silently posting a
 * token request without a `client_secret` would fail at the provider with a far
 * less legible error.
 */
function requireAuthCodeConfig<TConfig extends BaseOAuthConfig>(
  connectorName: string,
  config: TConfig,
): AuthCodeConfig<TConfig> {
  if (resolveOAuthFlow(config) !== 'authorization_code' || !config.clientSecret || !config.redirectUri) {
    throw new Error(
      `${connectorName}_flow_mismatch: this connection is configured for device flow — ` +
      `clientSecret and redirectUri are required for the authorization-code path`,
    );
  }
  return config as AuthCodeConfig<TConfig>;
}

// ── Device authorization grant (RFC 8628) ─────────────────────────────────────

/** Parsed `POST {deviceCodeUrl}` response — the start of a device flow. */
export interface DeviceAuthorization {
  /** Secret handle the server polls with. Never shown to the human. */
  deviceCode: string;
  /** Short code the human types at `verificationUri`. */
  userCode: string;
  /** Page the human opens to enter `userCode`, e.g. `https://github.com/login/device`. */
  verificationUri: string;
  /** Optional deep link with the code pre-filled (RFC 8628 §3.2). */
  verificationUriComplete?: string;
  /** Seconds until `deviceCode` stops being redeemable. */
  expiresIn: number;
  /** Minimum seconds the client must wait between polls. */
  interval: number;
}

/**
 * Outcome of a single poll of the token endpoint with a device code.
 *
 * `authorized` is the only terminal success — the token bundle is already
 * sealed by the time it is returned. `pending` / `slow_down` are keep-going
 * signals; `expired` / `denied` are terminal failures the UI must surface
 * rather than retry.
 */
export type DevicePollStatus = 'authorized' | 'pending' | 'slow_down' | 'expired' | 'denied';

/** Options for the blocking {@link ConnectorOAuth.pollDeviceTokenAndStore} loop. */
export interface DevicePollOptions {
  /** Seconds between polls; defaults to the provider-supplied interval. */
  interval?: number;
  /** Seconds before the device code dies; defaults to the provider's expires_in. */
  expiresIn?: number;
  /** Injection seam for tests — defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Extra seconds added to the poll interval on every `slow_down` (RFC 8628 §3.5
 * makes the increment implementation-defined; 5s is what GitHub documents).
 */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Fallbacks for providers that omit the optional pacing fields. */
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRY_SECONDS = 900;

/** Real-timer sleep used when the caller does not inject one. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** RFC 8628 grant_type for redeeming a device code. */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Map an OAuth error code from the device token endpoint to a poll status.
 * Unknown codes return undefined so the caller can throw rather than spin.
 */
function devicePollStatusForError(code: string): DevicePollStatus | undefined {
  switch (code) {
    case 'authorization_pending': return 'pending';
    case 'slow_down': return 'slow_down';
    case 'expired_token': return 'expired';
    case 'access_denied': return 'denied';
    default: return undefined;
  }
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
  /**
   * RFC 8628 device-authorization endpoint, e.g.
   * `'https://github.com/login/device/code'` (#1391).
   *
   * Presence is the opt-in: connectors that leave it unset get the same
   * authorization-code-only surface they had before, and their device-flow
   * entry points throw `${name}_device_unsupported` rather than silently
   * posting to a URL the provider does not serve.
   */
  deviceCodeUrl?: string;
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

  // ── Device authorization grant (#1391) ────────────────────────────────────

  /** True when this connector was built with a `deviceCodeUrl`. */
  supportsDeviceFlow(): boolean;
  /**
   * Start a device flow: ask the provider for a device code + user code using
   * the DID's sealed `clientId`. Requires no secret and no redirect URI.
   */
  requestDeviceCode(ownerDid: string): Promise<DeviceAuthorization>;
  /**
   * Poll the token endpoint once with `deviceCode`.
   *
   * On `'authorized'` the token bundle is already sealed for `ownerDid` before
   * this resolves — the access token is never returned to the caller, matching
   * the authorization-code path's custody rules. Throws only on transport
   * failures and unrecognised OAuth error codes; the four RFC 8628 states are
   * returned as values so a route can map them to HTTP without try/catch.
   */
  pollDeviceTokenOnce(ownerDid: string, deviceCode: string): Promise<DevicePollStatus>;
  /**
   * Blocking convenience wrapper: poll until authorized, honouring `slow_down`
   * backoff and giving up when the device code expires. Resolves once the token
   * bundle is sealed; throws `${name}_device_denied` / `${name}_device_expired`
   * on the terminal failures.
   *
   * Browser flows should drive `pollDeviceTokenOnce` from the client instead —
   * a serverless request that blocks for up to 15 minutes is not a request.
   */
  pollDeviceTokenAndStore(
    ownerDid: string,
    deviceCode: string,
    options?: DevicePollOptions,
  ): Promise<void>;
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
    await sealAndStoreV2(configField(ownerDid), JSON.stringify(config));
  }

  async function loadConfig(ownerDid: string): Promise<TConfig> {
    const field = configField(ownerDid);
    let raw: string | undefined;
    try {
      raw = await loadAndUnseal(field);
    } catch (err) {
      if (err instanceof VaultDelegationError) {
        throw new ConnectorCredentialPendingError(opts.name, field);
      }
      throw err;
    }
    if (raw === undefined) {
      throw new Error(`${opts.name}_no_config: DID ${ownerDid} has not configured a ${opts.name} connection`);
    }
    return opts.parseConfig(JSON.parse(raw));
  }

  async function storeTokens(ownerDid: string, tokens: TTokens): Promise<void> {
    await sealAndStoreV2(tokenField(ownerDid), JSON.stringify(tokens));
  }

  async function loadTokens(ownerDid: string): Promise<TTokens | undefined> {
    const field = tokenField(ownerDid);
    let raw: string | undefined;
    try {
      raw = await loadAndUnseal(field);
    } catch (err) {
      if (err instanceof VaultDelegationError) {
        throw new ConnectorCredentialPendingError(opts.name, field);
      }
      throw err;
    }
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as TTokens;
  }

  /**
   * POST the token endpoint and return the raw response, without asserting that
   * it carried an access token.
   *
   * Device polling needs this: the provider answers a not-yet-authorized poll
   * with HTTP 200 and `{"error":"authorization_pending"}`, which is a normal
   * step in the flow rather than a failure, so the error check has to live in
   * the caller instead of here.
   *
   * `client_secret` is attached only when the config actually has one — a
   * device-flow config has none, and RFC 8628 public clients must not send an
   * empty one.
   */
  async function postTokenRaw(config: TConfig, body: URLSearchParams): Promise<OAuthTokenResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (opts.tokenAuth === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret ?? ''}`).toString('base64')}`;
    } else {
      body.set('client_id', config.clientId);
      if (config.clientSecret) body.set('client_secret', config.clientSecret);
    }
    const res = await fetch(opts.tokenUrl, { method: 'POST', headers, body: body.toString() });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${opts.name}_token: token endpoint ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as OAuthTokenResponse;
  }

  /** `postTokenRaw` plus the "must have produced an access token" assertion. */
  async function postToken(config: TConfig, body: URLSearchParams): Promise<OAuthTokenResponse> {
    const data = await postTokenRaw(config, body);
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
    const config = requireAuthCodeConfig(opts.name, await loadConfig(ownerDid));
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
    const config = requireAuthCodeConfig(opts.name, await loadConfig(ownerDid));
    const data = await postToken(config, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    }));
    await storeTokens(ownerDid, opts.buildTokens(data, extra, undefined));
    log.info({ ownerDid }, `${opts.name} account connected via OAuth`);
  }

  // ── Device authorization grant (RFC 8628 — #1391) ───────────────────────────

  function supportsDeviceFlow(): boolean {
    return typeof opts.deviceCodeUrl === 'string' && opts.deviceCodeUrl.length > 0;
  }

  /** The device endpoint URL, or a legible throw when the connector opted out. */
  function requireDeviceCodeUrl(): string {
    if (!opts.deviceCodeUrl) {
      throw new Error(
        `${opts.name}_device_unsupported: ${opts.name} was not configured with a device-authorization endpoint`,
      );
    }
    return opts.deviceCodeUrl;
  }

  async function requestDeviceCode(ownerDid: string): Promise<DeviceAuthorization> {
    const url = requireDeviceCodeUrl();
    const config = await loadConfig(ownerDid);

    // No client_secret and no redirect_uri by design — that omission is the
    // entire point of the device path (#1391).
    const body = new URLSearchParams({ client_id: config.clientId, scope: opts.oauthScope });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `${opts.name}_device_code: device endpoint ${res.status} ${res.statusText}: ${text}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.error === 'string') {
      // The most common cause by far is "Enable Device Flow" being unchecked in
      // the owner's OAuth App, which GitHub reports as `device_flow_disabled`.
      throw new Error(
        `${opts.name}_device_code: ${data.error}: ${String(data.error_description ?? '')}`.trimEnd(),
      );
    }

    const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
    const userCode = typeof data.user_code === 'string' ? data.user_code : '';
    const verificationUri = typeof data.verification_uri === 'string' ? data.verification_uri : '';
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error(
        `${opts.name}_device_code: device endpoint response missing device_code / user_code / verification_uri`,
      );
    }

    log.info({ ownerDid }, `${opts.name} device authorization requested`);

    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete:
        typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : undefined,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_DEVICE_EXPIRY_SECONDS,
      interval: typeof data.interval === 'number' ? data.interval : DEFAULT_DEVICE_INTERVAL_SECONDS,
    };
  }

  async function pollDeviceTokenOnce(ownerDid: string, deviceCode: string): Promise<DevicePollStatus> {
    requireDeviceCodeUrl();
    const config = await loadConfig(ownerDid);

    const data = await postTokenRaw(config, new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
    }));

    if (typeof data.error === 'string' && data.error.length > 0) {
      const status = devicePollStatusForError(data.error);
      if (status === undefined) {
        throw new Error(
          `${opts.name}_device_token: ${data.error}: ${data.error_description ?? ''}`.trimEnd(),
        );
      }
      return status;
    }

    if (!data.access_token) {
      throw new Error(`${opts.name}_device_token: no access_token in device token response`);
    }

    // Sealed before returning: the caller only ever learns that it worked.
    await storeTokens(ownerDid, opts.buildTokens(data, {}, undefined));
    log.info({ ownerDid }, `${opts.name} account connected via device flow`);
    return 'authorized';
  }

  async function pollDeviceTokenAndStore(
    ownerDid: string,
    deviceCode: string,
    options: DevicePollOptions = {},
  ): Promise<void> {
    const sleep = options.sleep ?? defaultSleep;
    const budgetMs = (options.expiresIn ?? DEFAULT_DEVICE_EXPIRY_SECONDS) * 1000;
    let waitMs = (options.interval ?? DEFAULT_DEVICE_INTERVAL_SECONDS) * 1000;
    // Elapsed time is accumulated from the waits we actually performed rather
    // than read off the clock, so the deadline is deterministic under an
    // injected `sleep` (and unaffected by how slow the provider is to answer).
    let elapsedMs = 0;

    for (;;) {
      const status = await pollDeviceTokenOnce(ownerDid, deviceCode);
      if (status === 'authorized') return;
      if (status === 'denied') {
        throw new Error(`${opts.name}_device_denied: the owner declined the device authorization`);
      }
      if (status === 'expired') {
        throw new Error(`${opts.name}_device_expired: the device code expired before it was authorized`);
      }
      if (status === 'slow_down') {
        waitMs += SLOW_DOWN_INCREMENT_SECONDS * 1000;
      }
      if (elapsedMs + waitMs > budgetMs) {
        throw new Error(`${opts.name}_device_expired: the device code expired before it was authorized`);
      }
      await sleep(waitMs);
      elapsedMs += waitMs;
    }
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
    supportsDeviceFlow,
    requestDeviceCode,
    pollDeviceTokenOnce,
    pollDeviceTokenAndStore,
  };
}
