/**
 * App-token mint-and-refresh for the MCP proxy (imajin-ai#1932).
 *
 * Same CONSTRAINT as `packages/openclaw-infer-passthrough/src/token-provider.ts`'s
 * `RouteTokenProvider` (imajin-ai#1922 finding 6: the kernel's app-token JWT
 * is short-lived — ~10 minutes — with NO TTL-extension endpoint, so the only
 * way to stay "logged in" is to mint a fresh token ahead of expiry) but
 * implemented independently here, not imported — that package's `exports`
 * map only publishes its top-level HTTP server entry point.
 *
 * NOTE (harvested-checklist item — see docs/agents/nanoclaw-first-boot.md):
 * this proxy mints via the delegated app-token flow
 * (`POST /auth/api/apps/token`, requiring an `app.authorized` attestation),
 * the same mechanism `openclaw-infer-passthrough` uses for
 * `infer:completions`. The kernel's MCP tool surface is described elsewhere
 * (imajin-ai#1758) as "OAuth 2.1, scope-gated, EdDSA-verified" — confirming
 * whether MCP access uses this exact app-token endpoint or a separate
 * OAuth 2.1 token endpoint is an explicit manual/verify step for the
 * operator, not assumed here.
 */
import { randomBytes } from 'node:crypto';
import { crypto } from '@imajin/auth';
import { stripTrailingSlashes } from '../url-utils.js';

const DEFAULT_SCOPE = 'mcp';

export interface MintedToken {
  token: string;
  expiresIn: number;
}

/** Build the proof-of-possession challenge string the kernel's token-mint endpoint verifies against. */
function buildChallenge(appDid: string, attestationId: string, nonce: string, timestamp: string): string {
  return [appDid, attestationId, nonce, timestamp].join(':');
}

export async function mintAppToken(
  kernelBaseUrl: string,
  appDid: string,
  privateKeyHex: string,
  attestationId: string,
  scope: string = DEFAULT_SCOPE,
  fetchImpl: typeof fetch = fetch,
): Promise<MintedToken> {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = new Date().toISOString();
  const challenge = buildChallenge(appDid, attestationId, nonce, timestamp);
  const signature = crypto.signSync(challenge, privateKeyHex);

  const endpoint = `${stripTrailingSlashes(kernelBaseUrl)}/auth/api/apps/token`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid, attestationId, scope, nonce, timestamp, signature }),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(`Failed to mint app token: ${response.status} ${errorBody.error ?? response.statusText}`);
  }
  return (await response.json()) as MintedToken;
}

export interface TokenSource {
  getToken(): Promise<string>;
  invalidate(): void;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

export class RouteTokenProvider implements TokenSource {
  private cache: CachedToken | undefined;
  private inFlightMint: Promise<string> | undefined;

  constructor(
    private readonly kernelBaseUrl: string,
    private readonly appDid: string,
    private readonly privateKeyHex: string,
    private readonly attestationId: string,
    private readonly refreshSkewMs: number = 60_000,
    private readonly clock: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    if (this.cache && !this.isNearExpiry(this.cache)) {
      return this.cache.value;
    }
    return this.mintOnce();
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private isNearExpiry(cached: CachedToken): boolean {
    return this.clock() >= cached.expiresAtMs - this.refreshSkewMs;
  }

  /** Coalesce concurrent callers onto a single in-flight mint request. */
  private mintOnce(): Promise<string> {
    this.inFlightMint ??= this.mintAndCache().finally(() => {
      this.inFlightMint = undefined;
    });
    return this.inFlightMint;
  }

  private async mintAndCache(): Promise<string> {
    const minted = await mintAppToken(
      this.kernelBaseUrl,
      this.appDid,
      this.privateKeyHex,
      this.attestationId,
      DEFAULT_SCOPE,
      this.fetchImpl,
    );
    this.cache = { value: minted.token, expiresAtMs: this.clock() + minted.expiresIn * 1000 };
    return this.cache.value;
  }
}
