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
import { stripTrailingSlashes } from './url-utils.js';

const APP_TOKEN_SCOPE = 'infer:completions';

/**
 * @param scope Single scope to narrow the mint to (must be one of the
 *   attestation's granted scopes) — defaults to `infer:completions` when
 *   omitted, matching every pre-#2368 caller. Pass `null` EXPLICITLY to omit
 *   `scope` from the request entirely, which the kernel treats as "grant the
 *   attestation's full approved scope set" (the `/mcp` route's need — see
 *   `RouteTokenProvider`'s own doc comment for why `null`, not `undefined`,
 *   is the "no narrowing" sentinel here too).
 * @param aud Resource-server audience (RFC 8707) to bind the token to —
 *   omit for the kernel's own generic-apps default (`imajin:apps`). The
 *   `/mcp` route (#2368) requires this to be set to its resource identifier
 *   (`${MCP_PUBLIC_URL}/mcp`, see `apps/kernel/src/lib/mcp/oauth-config.ts`'s
 *   `getMcpResource()`) or every call 401s on the kernel's own audience gate.
 */
export async function mintAppToken(
  kernelBaseUrl: string,
  appDid: string,
  privateKeyHex: string,
  attestationId: string,
  scope: string | null = APP_TOKEN_SCOPE,
  aud?: string,
): Promise<MintedToken> {
  const nonce = randomBytes(16).toString('hex');
  const timestamp = new Date().toISOString();
  const challenge = `${appDid}:${attestationId}:${nonce}:${timestamp}`;
  const signature = crypto.signSync(challenge, privateKeyHex);
  // `scope === null` must produce an OMITTED key, not a `null` value in the
  // JSON body — the kernel's route only special-cases an absent `scope`,
  // treating a body with `"scope": null` as a truthy-check miss the same as
  // any other unexpected type. `JSON.stringify` drops `undefined` values but
  // keeps `null` ones, so the two are not interchangeable here.
  const resolvedScope = scope === null ? undefined : scope;

  const res = await fetch(`${stripTrailingSlashes(kernelBaseUrl)}/auth/api/apps/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appDid, attestationId, scope: resolvedScope, aud, nonce, timestamp, signature }),
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
 * A `TokenSource` that can also report which scopes the currently-cached
 * token actually carries (#2368) — `mcp-handler.ts` uses this to enforce the
 * "agent must hold at least one recognized MCP-surface scope" gate before
 * ever forwarding a JSON-RPC call to the kernel. `getScopes()` ensures a
 * valid token first (minting if needed), exactly like `getToken()`.
 */
export interface ScopedTokenSource extends TokenSource {
  getScopes(): Promise<string[]>;
}

/**
 * Caches one route's app token and refreshes it before the kernel's 10-minute
 * TTL expires. No TTL-extension request exists (deliberate epic decision,
 * imajin-ai#1922 finding 6) — the only way to keep a route "logged in" is to
 * mint a fresh token, which is exactly what `getToken()` does once the cached
 * one is within `refreshSkewMs` of expiring.
 */
export class RouteTokenProvider implements ScopedTokenSource {
  private cached: { token: string; expiresAt: number; scopes: string[] } | null = null;
  private mintPromise: Promise<string> | null = null;

  /**
   * @param scope Narrows the mint to one scope, matching every pre-#2368
   *   caller's behavior (defaults to `infer:completions`). Pass `null`
   *   explicitly to skip narrowing and receive the attestation's FULL
   *   granted scope set instead — `null`, not `undefined`, because a
   *   defaulted constructor parameter falls back to its default on an
   *   `undefined` argument, which would silently re-narrow to
   *   `infer:completions` instead of honoring an explicit "give me
   *   everything granted" request (the `/mcp` route's own need — see
   *   `mcp-handler.ts`).
   * @param aud Resource-server audience to bind the mint to — see
   *   `mintAppToken`'s own doc comment. Omitted for every route except `mcp`.
   */
  constructor(
    private readonly kernelBaseUrl: string,
    private readonly appDid: string,
    private readonly privateKeyHex: string,
    private readonly attestationId: string,
    private readonly refreshSkewMs: number = 60_000,
    private readonly now: () => number = Date.now,
    private readonly scope: string | null = APP_TOKEN_SCOPE,
    private readonly aud?: string,
  ) {}

  /** Get a valid token, minting or refreshing as needed. Coalesces concurrent callers onto one mint. */
  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.refreshSkewMs > this.now()) {
      return this.cached.token;
    }
    this.mintPromise ??= this.refresh().finally(() => {
      this.mintPromise = null;
    });
    return this.mintPromise;
  }

  /** The scopes the currently-cached (or freshly minted) token actually carries. */
  async getScopes(): Promise<string[]> {
    await this.getToken();
    return this.cached?.scopes ?? [];
  }

  /** Force the next `getToken()` call to mint fresh — e.g. after a 401 from the kernel. */
  invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const minted = await mintAppToken(this.kernelBaseUrl, this.appDid, this.privateKeyHex, this.attestationId, this.scope, this.aud);
    this.cached = { token: minted.token, expiresAt: this.now() + minted.expiresIn * 1000, scopes: minted.scopes };
    return this.cached.token;
  }
}
