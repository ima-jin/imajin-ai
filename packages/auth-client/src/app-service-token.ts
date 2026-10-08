/**
 * App-service token client (#2739, kernel side: #1141 / #2642).
 *
 * A registered app that needs to authenticate its OWN backend calls to the
 * kernel — as itself, with no signed-in user — mints a short-lived
 * (`typ: app-service+jwt`) token from `POST {kernelUrl}/auth/api/apps/token/service`
 * by proving possession of its Ed25519 signing key (the one it fetches with
 * `loadAppSigningKey`): a raw signature over `${appDid}:${nonce}:${timestamp}`.
 * It then presents that token as `Authorization: Bearer <token>` — e.g. on
 * the pay service's `/api/checkout` and `/api/settle`.
 *
 * Server-only: this module signs with the app's private key and uses
 * `node:crypto`, so it is exported from the root entry only and must never be
 * pulled into `./browser` (`tests/browser-entry.test.ts` enforces that).
 *
 * The signing key is only ever handed to the signer in memory; it is never
 * logged, never part of a thrown error message, and never sent over the wire.
 */
import { randomBytes } from 'node:crypto';
import { signBootstrapPayload } from './ed25519';

/** Kernel path that mints an app-service token. */
const SERVICE_TOKEN_PATH = '/auth/api/apps/token/service';

/** Refresh once this fraction of the token's TTL has elapsed. */
const DEFAULT_REFRESH_RATIO = 0.8;

export interface RequestAppServiceTokenOptions {
  /** The kernel's own base URL, e.g. https://jin.imajin.ai. */
  kernelUrl: string;
  /** This app's own DID, as minted by `apps.provision`. */
  appDid: string;
  /** The app's Ed25519 private key, hex-encoded (`loadAppSigningKey().privateKey`). Held in memory only. */
  privateKey: string;
  /** Extra fetch options, merged under the defaults. */
  fetchOptions?: RequestInit;
}

export interface AppServiceToken {
  token: string;
  /** Server-side TTL in seconds. */
  expiresIn: number;
  /** Scopes the kernel actually granted (clamped to the operator-approved set). */
  scopes: string[];
}

interface ServiceTokenResponseBody {
  token?: unknown;
  expiresIn?: unknown;
  scopes?: unknown;
  error?: unknown;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Mint an app-service token by proving possession of the app's signing key.
 * Throws a value-free, descriptive error on any failure (a token IS the app's
 * identity toward the kernel, so callers must not degrade to "unauthenticated").
 */
export async function requestAppServiceToken(options: RequestAppServiceTokenOptions): Promise<AppServiceToken> {
  const nonce = randomBytes(16).toString('hex'); // >= 16 chars required by the kernel
  const timestamp = new Date().toISOString();
  const signature = signBootstrapPayload(`${options.appDid}:${nonce}:${timestamp}`, options.privateKey);

  let res: Response;
  try {
    res = await fetch(`${trimTrailingSlash(options.kernelUrl)}${SERVICE_TOKEN_PATH}`, {
      method: 'POST',
      ...options.fetchOptions,
      headers: { 'Content-Type': 'application/json', ...options.fetchOptions?.headers },
      body: JSON.stringify({ appDid: options.appDid, nonce, timestamp, signature }),
    });
  } catch (err) {
    throw new Error(`requestAppServiceToken: could not reach the kernel (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as ServiceTokenResponseBody | null;
  if (!res.ok) {
    // Only the kernel's own short, value-free `error` string — never any other part of the body.
    const reason = typeof body?.error === 'string' ? body.error : `status ${res.status}`;
    throw new Error(`requestAppServiceToken: token mint failed (${reason})`);
  }
  if (typeof body?.token !== 'string' || typeof body.expiresIn !== 'number') {
    throw new TypeError('requestAppServiceToken: token mint response was malformed');
  }

  return {
    token: body.token,
    expiresIn: body.expiresIn,
    scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [],
  };
}

export interface AppServiceTokenProviderOptions extends RequestAppServiceTokenOptions {
  /** Fraction of the TTL after which the cached token is refreshed (default 0.8). */
  refreshRatio?: number;
  /** Clock override (ms since epoch) — tests only. */
  now?: () => number;
}

export interface AppServiceTokenProvider {
  /** The current token, minting (or refreshing) one when none is cached or it is near expiry. */
  getToken(): Promise<string>;
  /** Drop the cached token, e.g. after the kernel answered 401 — the next `getToken()` mints a fresh one. */
  invalidate(): void;
}

/**
 * A cached app-service token source: concurrent callers share one in-flight
 * mint, and a token is reused until `refreshRatio` of its TTL has elapsed.
 */
export function createAppServiceTokenProvider(options: AppServiceTokenProviderOptions): AppServiceTokenProvider {
  const { refreshRatio = DEFAULT_REFRESH_RATIO, now = Date.now, ...mintOptions } = options;
  let cached: { token: string; refreshAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const minted = await requestAppServiceToken(mintOptions);
    cached = { token: minted.token, refreshAt: now() + minted.expiresIn * 1000 * refreshRatio };
    return minted.token;
  }

  return {
    async getToken() {
      if (cached && now() < cached.refreshAt) return cached.token;
      inflight ??= mint().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}
