/**
 * Market's own app-service token (#2740, #2642).
 *
 * `POST /pay/api/settle` no longer accepts the shared pay service key; a
 * registered app authenticates as itself with an app-service token
 * (`typ: app-service+jwt`) carrying the operator-approved `pay:settle` scope.
 * The same token authenticates market's `/pay/api/checkout` call, which is
 * what binds the payment to market's app DID.
 *
 * The token is minted via `POST {AUTH_SERVICE_URL}/api/apps/token/service`
 * with proof of possession of the app's signing key (a signature over
 * `${appDid}:${nonce}:${timestamp}`). The key is fetched from the kernel
 * through `loadAppSigningKey` — memory-only, never written to disk, env or a
 * log line — and the token is cached until 80% of its TTL.
 *
 * Fails loud: any problem (no registration, kernel unreachable, rejected
 * signature) throws a value-free error; callers decide how to degrade.
 */
import { randomBytes } from 'node:crypto';
import { loadAppSigningKey, signBootstrapPayload, type AppSigningKey } from '@imajin/auth-client';

/** Refresh at 80% of the kernel-reported TTL, like the broker-agent's TokenProvider. */
const REFRESH_RATIO = 0.8;
/** The kernel mints 10-minute tokens; used only if the response omits `expiresIn`. */
const DEFAULT_TTL_SECONDS = 600;

interface CachedToken {
  token: string;
  refreshAtMs: number;
}

let signingKeyPromise: Promise<AppSigningKey> | null = null;
let cachedToken: CachedToken | null = null;
let inflightMint: Promise<string> | null = null;

function authServiceUrl(): string {
  const url = process.env.AUTH_SERVICE_URL;
  if (!url) throw new Error('app-token: AUTH_SERVICE_URL is not set');
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Load (once) this app's signing key. A failed load is not memoized, so the next call retries. */
function getSigningKey(): Promise<AppSigningKey> {
  signingKeyPromise ??= loadAppSigningKey().catch((err: unknown) => {
    signingKeyPromise = null;
    throw err;
  });
  return signingKeyPromise;
}

async function mintServiceToken(): Promise<string> {
  const key = await getSigningKey();
  const nonce = randomBytes(16).toString('hex'); // 32 hex chars; the kernel requires >= 16
  const timestamp = new Date().toISOString();
  const signature = signBootstrapPayload(`${key.appDid}:${nonce}:${timestamp}`, key.privateKey);

  let res: Response;
  try {
    res = await fetch(`${authServiceUrl()}/api/apps/token/service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appDid: key.appDid, nonce, timestamp, signature }),
    });
  } catch (err) {
    throw new Error(`app-token: could not reach the auth service (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as { token?: unknown; expiresIn?: unknown; error?: unknown } | null;
  if (!res.ok) {
    const reason = typeof body?.error === 'string' ? body.error : `status ${res.status}`;
    throw new Error(`app-token: service token mint failed (${reason})`);
  }
  if (typeof body?.token !== 'string' || body.token.length === 0) {
    throw new TypeError('app-token: service token mint response was malformed');
  }

  const ttlSeconds = typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : DEFAULT_TTL_SECONDS;
  cachedToken = { token: body.token, refreshAtMs: Date.now() + ttlSeconds * REFRESH_RATIO * 1000 };
  return body.token;
}

/** The app-service token to send as `Authorization: Bearer`. Mints on first use and refreshes before expiry. */
export async function getAppServiceToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.refreshAtMs) return cachedToken.token;
  // Coalesce concurrent callers onto a single mint.
  inflightMint ??= mintServiceToken().finally(() => {
    inflightMint = null;
  });
  return inflightMint;
}

/** Drop every cached credential (the signing key and the token). Used by tests. */
export function resetAppServiceTokenCache(): void {
  signingKeyPromise = null;
  cachedToken = null;
  inflightMint = null;
}
