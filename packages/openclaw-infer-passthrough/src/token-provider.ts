/**
 * App-token mint-and-refresh for the kernel completions passthrough
 * (imajin-ai#1926, consuming imajin-ai#1925's `/infer/v1/chat/completions`).
 *
 * `infer:completions` is NOT in the service-eligible scope fence
 * (`packages/auth/src/scope-vocabulary.ts` — `serviceEligible` defaults to
 * false and this scope does not opt in), so a session-less app-service token
 * (`POST /auth/api/apps/token/service`, the shape `apps/broker-agent`'s
 * `mintAppToken` uses) cannot carry it. This shim instead mints the
 * user-delegated app token (`POST /auth/api/apps/token`, `app+jwt`), which
 * additionally requires an `attestationId` — the `app.authorized` consent
 * record the principal granted this app DID with `infer:completions` in
 * scope. The minted token's `sub` (and therefore `resolveInferenceAuth`'s
 * `ownerDid`) is derived kernel-side from that attestation's `issuerDid`;
 * the shim never sends the principal DID directly.
 *
 * The proof-of-possession challenge shape
 * (`${appDid}:${attestationId}:${nonce}:${timestamp}`, signed with the raw
 * Ed25519 primitive) mirrors `apps/kernel/app/auth/api/apps/token/route.ts`
 * exactly, and `crypto.signSync` (not the `SignedMessage`-wrapping `signSync`
 * also exported from `@imajin/auth`'s top level) is required for the same
 * reason `docs/guide/service-credentials.md` calls out for the service-token
 * sibling: the kernel verifies the raw primitive, not an envelope.
 */
import { randomBytes } from 'node:crypto';
import { crypto } from '@imajin/auth';
import type { MintedToken } from './types.js';

const APP_TOKEN_SCOPE = 'infer:completions';

export async function mintAppToken(
  kernelBaseUrl: string,
  appDid: string,
  privateKeyHex: string,
  attestationId: string,
  scope: string = APP_TOKEN_SCOPE,
): Promise<MintedToken> {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = new Date().toISOString();
  const challenge = `${appDid}:${attestationId}:${nonce}:${timestamp}`;
  const signature = crypto.signSync(challenge, privateKeyHex);

  const res = await fetch(`${kernelBaseUrl.replace(/\/+$/, '')}/auth/api/apps/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid, attestationId, scope, nonce, timestamp, signature }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    // Never interpolate the signature/challenge/nonce into this message —
    // only the kernel's own (non-secret) error string and HTTP status.
    throw new Error(`Failed to mint app token: ${res.status} ${body.error ?? res.statusText}`);
  }

  return (await res.json()) as MintedToken;
}

/** Minimal surface `handle-completions.ts` needs — lets tests inject a stub instead of a real `RouteTokenProvider`. */
export interface TokenSource {
  getToken(): Promise<string>;
  invalidate(): void;
}

/**
 * Caches one route's app token and refreshes it before the kernel's 10-minute
 * TTL expires. No TTL-extension request exists (deliberate epic decision,
 * imajin-ai#1922 finding 6) — the only way to keep a route "logged in" is to
 * mint a fresh token, which is exactly what `getToken()` does once the cached
 * one is within `refreshSkewMs` of expiring.
 */
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
  ) {}

  /** Get a valid token, minting or refreshing as needed. Coalesces concurrent callers onto one mint. */
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

  /** Force the next `getToken()` call to mint fresh — e.g. after a 401 from the kernel. */
  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const minted = await mintAppToken(this.kernelBaseUrl, this.appDid, this.privateKeyHex, this.attestationId);
    this.cached = { token: minted.token, expiresAt: this.now() + minted.expiresIn * 1000 };
    return this.cached.token;
  }
}
