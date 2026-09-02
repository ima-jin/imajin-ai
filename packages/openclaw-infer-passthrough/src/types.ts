/**
 * Shared types for the kernel-inference passthrough shim (imajin-ai#1926).
 */

/**
 * One OpenClaw "custom provider" route.
 *
 * `id` is the path segment OpenClaw's custom-provider `baseUrl` can point at
 * directly (`http://127.0.0.1:PORT/{id}/v1/chat/completions`) — the
 * unambiguous, preferred wiring, since each upstream gets its own OpenClaw
 * custom-provider entry anyway (imajin-ai#1922 Phase 1: one `BRAIN_CONNECTORS`
 * entry per provider). `modelPrefixes` is a fallback for callers that share a
 * single `baseUrl`/`/v1/chat/completions` and rely on the `model` field in the
 * request body to select a route instead.
 *
 * `attestationId` is the `app.authorized` consent record `principalDid`
 * issued to the OpenClaw app DID with the `infer:completions` scope
 * (imajin-ai#1922 finding 5 — use-not-see via an existing delegation grant,
 * no new grant type). Minting a token for this route always resolves back to
 * `principalDid` kernel-side (the token's `sub` is `attestationId`'s
 * `issuerDid`) — `principalDid` is carried here for config validation,
 * logging, and the runbook's per-route bookkeeping, not because the mint
 * call needs it directly.
 */
export interface ProviderRouteConfig {
  /** Stable route id, e.g. 'xai', 'openai', 'gemini', 'moonshot', 'anthropic'. */
  id: string;
  /** The owner DID whose sealed connector card this route spends against. */
  principalDid: string;
  /** The `app.authorized` attestation granting this app `infer:completions` onBehalfOf principalDid. */
  attestationId: string;
  /** Model-id prefixes that select this route on the unprefixed `/v1/chat/completions` path. */
  modelPrefixes?: string[];
  /**
   * Break-glass direct endpoint (OpenAI-compatible `/chat/completions` base),
   * e.g. `https://api.x.ai/v1`. Omit to disable fallback for this route —
   * a kernel 5xx/timeout then surfaces the kernel's own error to the caller.
   */
  directBaseUrl?: string;
  /**
   * Name of the environment variable holding the direct provider API key.
   * Never the key itself — config files carry no secrets (imajin-ai#1926).
   */
  directApiKeyEnvVar?: string;
}

export interface ProxyConfig {
  host: string;
  port: number;
  kernelBaseUrl: string;
  /** Time-to-first-byte deadline for the kernel call, in milliseconds. */
  kernelTimeoutMs: number;
  /** Time-to-first-byte deadline for a break-glass direct call, in milliseconds. */
  directTimeoutMs: number;
  appDid: string;
  /** Raw hex Ed25519 private key seed. Never logged, never echoed in any response. */
  appPrivateKey: string;
  routes: ProviderRouteConfig[];
}

export interface MintedToken {
  token: string;
  expiresIn: number;
  scopes: string[];
}
