/**
 * Acceptance-scenario regression coverage for imajin-ai#1926's first concrete
 * deliverable (2026-09-10 scoping comment): the `gpt-6-astra` delegated seat,
 * routed through the `openai` route id, authenticating as the agent's own DID.
 *
 * `handle-completions.test.ts` already proves the underlying kernel-then-
 * break-glass mechanics generically (using `xai`/`anthropic` route fixtures)
 * — this file pins the exact `openai` / `gpt-6-astra` shape the runbook
 * promises operators, so a regression in route resolution, raw-body-passthrough
 * (`model` must reach the kernel unchanged — the kernel's own `resolveBrain`
 * is what actually pins the served model, per brain.ts), or the spend-cap
 * (402) verbatim-forward guarantee fails a test named for the scenario, not
 * just a differently-labelled generic case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleCompletions, type HandleCompletionsDeps } from '../src/handle-completions.js';
import { HealthTracker } from '../src/health.js';
import { createLogger } from '../src/logger.js';
import type { ProviderRouteConfig } from '../src/types.js';
import { bodyToText, fakeTokenSource } from './dispatch-test-support.js';

const OPENAI_ROUTE: ProviderRouteConfig = {
  id: 'openai',
  principalDid: 'did:imajin:jin',
  attestationId: 'att-openai',
  modelPrefixes: ['gpt-', 'o1-', 'o3-'],
  directBaseUrl: 'https://api.openai.com/v1',
  directApiKeyEnvVar: 'OPENAI_DIRECT_API_KEY',
};

function baseDeps(overrides: Partial<HandleCompletionsDeps> = {}): HandleCompletionsDeps {
  return {
    routes: [OPENAI_ROUTE],
    kernelBaseUrl: 'https://kernel.test',
    kernelTimeoutMs: 5_000,
    directTimeoutMs: 5_000,
    getTokenProvider: () => fakeTokenSource(['tok-agent-did']),
    resolveDirectApiKey: () => 'direct-openai-key',
    health: new HealthTracker(),
    log: createLogger('test'),
    ...overrides,
  };
}

describe('gpt-6-astra delegated seat via the "openai" route (imajin-ai#1926)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('routes a path-prefixed sessions_spawn-style request to the kernel with the request body — including model — forwarded byte for byte', async () => {
    const requestBody = JSON.stringify({
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: 'spawn task' }],
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://kernel.test/infer/v1/chat/completions');
      // The kernel — not this proxy — is what pins the served model to
      // whatever is sealed on the DID's connector card (brain.ts); this shim
      // must never rewrite `model` itself, so the exact client body rides
      // through unchanged.
      expect(init?.body).toBe(requestBody);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-agent-did');
      return new Response(JSON.stringify({ id: 'chatcmpl-astra-1', model: 'gpt-6-astra', choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleCompletions(baseDeps(), { providerIdFromPath: 'openai', bodyText: requestBody });

    expect(result.status).toBe(200);
    expect(await bodyToText(result.body)).toContain('gpt-6-astra');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('also resolves the openai route from body.model on the unprefixed path (modelPrefixes fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe('https://kernel.test/infer/v1/chat/completions');
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    const result = await handleCompletions(baseDeps(), { bodyText: JSON.stringify({ model: 'gpt-6-astra', messages: [] }) });
    expect(result.status).toBe(200);
  });

  it('forwards a kernel 402 spend_cap_exceeded response verbatim and never attempts break-glass fallback', async () => {
    const spendCapBody = JSON.stringify({
      error: 'spend_cap_exceeded',
      message: 'Spend cap reached for this connector — raise the cap or wait for the window to reset',
      spentUsd: 12.5,
      capUsd: 10,
      period: 'monthly',
    });
    const fetchMock = vi.fn(async () => new Response(spendCapBody, { status: 402, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleCompletions(baseDeps(), {
      providerIdFromPath: 'openai',
      bodyText: JSON.stringify({ model: 'gpt-6-astra', messages: [] }),
    });

    expect(result.status).toBe(402);
    expect(await bodyToText(result.body)).toBe(spendCapBody);
    // Exactly one call: the route HAS a directBaseUrl/directApiKeyEnvVar
    // configured, so a bug that mistreated 402 as fallback-eligible would
    // show up here as a second (direct-provider) call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.headers['Content-Type']).toBe('application/json');
    expect(baseDeps().health.snapshot().fallbackCount).toBe(0);
  });
});
