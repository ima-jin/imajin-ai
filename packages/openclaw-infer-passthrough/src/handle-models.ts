/**
 * Request orchestration for `GET /openai/v1/models` (imajin-ai#2201).
 *
 * Mints (or reuses) the SAME kind of route token the OpenAI-compatible
 * completions path uses (`getTokenProvider('openai')`), retries once with a
 * freshly-minted token on a 401 (same rule `dispatch.ts`'s
 * `attemptKernelCall` applies to completions), and forwards the kernel's
 * `GET /infer/v1/models/usable` body back unchanged. No break-glass fallback:
 * unlike a completions call, there is no direct-provider equivalent that
 * would return the SAME thing (the principal's sealed connectors) — a
 * kernel outage here just means model discovery is briefly unavailable, not
 * a chat-completions site.
 */
import { toProxyResponse, type ProxyResponse } from './dispatch.js';
import type { TokenSource } from './token-provider.js';
import { forwardModelsToKernel } from './upstream.js';

export interface HandleModelsDeps {
  kernelBaseUrl: string;
  kernelTimeoutMs: number;
  getTokenProvider(routeId: string): TokenSource;
}

/** Models discovery rides the same 'openai' route/seat the OpenAI-compatible completions path already mints a token for. */
const MODELS_ROUTE_ID = 'openai';

export async function handleModels(deps: HandleModelsDeps): Promise<ProxyResponse> {
  const tokenProvider = deps.getTokenProvider(MODELS_ROUTE_ID);

  const token = await tokenProvider.getToken();
  const first = await forwardModelsToKernel(deps.kernelBaseUrl, token, deps.kernelTimeoutMs);
  if (first.status !== 401) return toProxyResponse(first);

  tokenProvider.invalidate();
  const freshToken = await tokenProvider.getToken();
  const retried = await forwardModelsToKernel(deps.kernelBaseUrl, freshToken, deps.kernelTimeoutMs);
  return toProxyResponse(retried);
}
