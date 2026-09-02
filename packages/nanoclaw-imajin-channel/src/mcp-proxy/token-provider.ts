/**
 * App-token mint-and-refresh for the MCP proxy (imajin-ai#1932).
 *
 * Same shape as `packages/openclaw-infer-passthrough/src/token-provider.ts`'s
 * `RouteTokenProvider` (imajin-ai#1922 finding 6: the kernel's app-token JWT
 * is short-lived — ~10 minutes — with NO TTL-extension endpoint, so the only
 * way to stay "logged in" is to mint a fresh token, which is exactly what
 * `getToken()` does once the cached one nears expiry).
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

const APP_TOKEN_SCOPE = 'mcp';

export interface MintedToken {
  token: string;
  expiresIn: number;
}

export async function mintAppToken(
  kernelBaseUrl: string,
  appDid: string,
  privateKeyHex: string,
  attestationId: string,
  scope: string = APP_TOKEN_SCOPE,
  fetchImpl: typeof fetch = fetch,
): Promise<MintedToken> {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = new Date().toISOString();
  const challenge = `${appDid}:${attestationId}:${nonce}:${timestamp}`;
  const signature = crypto.signSync(challenge, privateKeyHex);

  const res = await fetchImpl(`${kernelBaseUrl.replace(/\/+$/, '')}/auth/api/apps/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid, attestationId, scope, nonce, timestamp, signature }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(`Failed to mint app token: ${res.status} ${body.error ?? res.statusText}`);
  }
  return (await res.json()) as MintedToken;
}

export interface TokenSource {
  getToken(): Promise<string>;
  invalidate(): void;
}

export class RouteTokenProvider implements TokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private mintPromise: Promise<string> | null = null;

  constructor(
    private readonly kernelBaseUrl: string,
    private readonly appDid: string,
    private readonly privateKeyHex: string,
    private readonly attestationId: string,
    private readonly refreshSkewMs: number = 60_000,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.refreshSkewMs > this.now()) {
      return this.cached.token;
    }
    if (!this.mintPromise) {
      this.mintPromise = this.refresh().finally(() => {
        this.mintPromise = null;
      });
    }
    return this.mintPromise;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const minted = await mintAppToken(
      this.kernelBaseUrl,
      this.appDid,
      this.privateKeyHex,
      this.attestationId,
      APP_TOKEN_SCOPE,
      this.fetchImpl,
    );
    this.cached = { token: minted.token, expiresAt: this.now() + minted.expiresIn * 1000 };
    return this.cached.token;
  }
}
