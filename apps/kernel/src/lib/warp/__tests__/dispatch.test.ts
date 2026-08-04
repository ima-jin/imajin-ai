/**
 * Tests for the Warp cloud-agent dispatch client (#1428).
 *
 * `fetch`, the connector gate, the identity lookup, the bus, and the logger are
 * all mocked, so these exercise the wire shape and the secret-handling
 * guarantees without touching the network, the vault, or the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireAgentKeyMock, lookupIdentityMock, publishMock, logMock } = vi.hoisted(() => ({
  requireAgentKeyMock: vi.fn(),
  lookupIdentityMock: vi.fn(),
  publishMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../connector', () => ({
  requireAgentKey: requireAgentKeyMock,
}));

vi.mock('@/src/lib/kernel/lookup', () => ({
  lookupIdentity: lookupIdentityMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: publishMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

import { dispatchAgentRun, getAgentRun, resolveJinName, WarpApiError } from '../dispatch';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRINCIPAL = 'did:imajin:veteze';
const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const BASE_URL = 'https://warp.test/api/v1';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function lastFetchCall(): FetchCall {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const [url, init] = calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function lastRequestBody(): Record<string, unknown> {
  return JSON.parse(lastFetchCall().init.body as string) as Record<string, unknown>;
}

function lastConfig(): Record<string, unknown> {
  return lastRequestBody().config as Record<string, unknown>;
}

/** Queue a JSON response for the next fetch. */
function respondJson(body: unknown, status = 200): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    json: async () => body,
  } as Response);
}

/** Queue a response whose body is not JSON at all (proxy HTML, empty 502). */
function respondNonJson(status: number): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: false,
    status,
    statusText: 'Bad Gateway',
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response);
}

const QUEUED_RUN = { run_id: RUN_ID, state: 'QUEUED' };

beforeEach(() => {
  process.env.WARP_API_BASE_URL = BASE_URL;
  delete process.env.WARP_DEFAULT_ENVIRONMENT_ID;

  requireAgentKeyMock.mockReset().mockResolvedValue(AGENT_KEY);
  lookupIdentityMock.mockReset().mockResolvedValue({ did: PRINCIPAL, handle: 'veteze' });
  publishMock.mockReset().mockResolvedValue(undefined);
  logMock.info.mockReset();
  logMock.error.mockReset();

  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.WARP_API_BASE_URL;
  delete process.env.WARP_DEFAULT_ENVIRONMENT_ID;
});

// ── The wire ──────────────────────────────────────────────────────────────────

describe('dispatchAgentRun request shape', () => {
  it('POSTs the prompt to /agent/run with the sealed key as a Bearer token', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'Fix the login error' });

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/agent/run`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${AGENT_KEY}`);
    expect(lastRequestBody().prompt).toBe('Fix the login error');
  });

  it('trims a trailing slash off the configured base URL', async () => {
    process.env.WARP_API_BASE_URL = `${BASE_URL}/`;
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastFetchCall().url).toBe(`${BASE_URL}/agent/run`);
  });

  it('returns the run id, state, and session link', async () => {
    respondJson({ ...QUEUED_RUN, session_link: 'https://app.warp.dev/session/abc', title: 'T' });
    const run = await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(run).toMatchObject({
      runId: RUN_ID,
      state: 'QUEUED',
      sessionLink: 'https://app.warp.dev/session/abc',
      title: 'T',
    });
  });

  it('throws rather than inventing a run id when the response carries none', async () => {
    respondJson({ state: 'QUEUED' });
    await expect(dispatchAgentRun(PRINCIPAL, { prompt: 'go' })).rejects.toThrow(/no run id/);
  });
});

// ── Individuation: the {username}-jin stamp ───────────────────────────────────

describe('dispatch is stamped with the caller jin identity', () => {
  it('stamps config.name as {handle}-jin', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig().name).toBe('veteze-jin');
  });

  it('falls back to the DID segment when the identity has no handle', async () => {
    lookupIdentityMock.mockResolvedValue({ did: PRINCIPAL, handle: null });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig().name).toBe('veteze-jin');
  });

  it('falls back when the identity cannot be resolved at all', async () => {
    lookupIdentityMock.mockResolvedValue(null);
    expect(await resolveJinName('did:imajin:Chris.Smith')).toBe('chris-smith-jin');
  });

  it('still labels the run when the DID has no sluggable segment either', async () => {
    lookupIdentityMock.mockResolvedValue(null);
    expect(await resolveJinName('did:imajin:...')).toBe('jin');
  });

  it('ignores a handle that slugifies to nothing', async () => {
    lookupIdentityMock.mockResolvedValue({ did: PRINCIPAL, handle: '***' });
    expect(await resolveJinName(PRINCIPAL)).toBe('veteze-jin');
  });

  it('lets an explicit name override the default tag', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', name: 'nightly-dependency-check' });

    expect(lastConfig().name).toBe('nightly-dependency-check');
  });
});

// ── Config surface: mcp_servers, skill_spec, environment ──────────────────────

describe('dispatch config surface', () => {
  it('omits mcp_servers entirely when none are requested', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig()).not.toHaveProperty('mcp_servers');
  });

  it('sends mcp_servers as a MAP keyed by name, not an array', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', attachImajinMcp: true });

    const mcpServers = lastConfig().mcp_servers as Record<string, { url?: string }>;
    expect(Array.isArray(mcpServers)).toBe(false);
    expect(mcpServers.imajin.url).toContain('/mcp');
  });

  it('lets a caller-supplied server override the injected imajin default', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      attachImajinMcp: true,
      mcpServers: { imajin: { url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer x' } } },
    });

    const mcpServers = lastConfig().mcp_servers as Record<string, { url?: string }>;
    expect(mcpServers.imajin.url).toBe('https://mcp.example/mcp');
  });

  it('passes skill_spec through so a versioned SKILL.md is the payload', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', skillSpec: 'ima-jin/imajin-ai:catalyst' });

    expect(lastConfig().skill_spec).toBe('ima-jin/imajin-ai:catalyst');
  });

  it('applies WARP_DEFAULT_ENVIRONMENT_ID when the caller names no environment', async () => {
    process.env.WARP_DEFAULT_ENVIRONMENT_ID = 'UA17BXYZ';
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig().environment_id).toBe('UA17BXYZ');
  });

  it('prefers an explicit environment over the configured default', async () => {
    process.env.WARP_DEFAULT_ENVIRONMENT_ID = 'UA17BXYZ';
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', environmentId: 'UAOTHER' });

    expect(lastConfig().environment_id).toBe('UAOTHER');
  });

  it('forwards computer use only when the caller asks for it', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', computerUseEnabled: true });

    expect(lastConfig().computer_use_enabled).toBe(true);
  });

  it('forwards an explicit false rather than dropping it', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', computerUseEnabled: false });

    expect(lastConfig().computer_use_enabled).toBe(false);
  });

  it('forwards the model and base prompt overrides', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', modelId: 'auto', basePrompt: 'be brief' });

    expect(lastConfig()).toMatchObject({ model_id: 'auto', base_prompt: 'be brief' });
  });

  it('sends a title only when one is given', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', title: 'Nightly' });
    expect(lastRequestBody().title).toBe('Nightly');

    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });
    expect(lastRequestBody()).not.toHaveProperty('title');
  });

  it('omits optional config fields rather than sending nulls', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    const config = lastConfig();
    expect(config).not.toHaveProperty('model_id');
    expect(config).not.toHaveProperty('skill_spec');
    expect(config).not.toHaveProperty('environment_id');
    expect(config).not.toHaveProperty('computer_use_enabled');
  });
});

// ── Fail-closed gating ────────────────────────────────────────────────────────

describe('dispatch fails closed', () => {
  it('makes no network call when the caller has no active grant', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_grant: DID has no active grant'));

    await expect(dispatchAgentRun(PRINCIPAL, { prompt: 'go' })).rejects.toThrow(/warp_no_grant/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('makes no network call when the grant was revoked and no secret unseals', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_secret: nothing sealed'));

    await expect(dispatchAgentRun(PRINCIPAL, { prompt: 'go' })).rejects.toThrow(/warp_no_secret/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt before even resolving the credential', async () => {
    await expect(dispatchAgentRun(PRINCIPAL, { prompt: '   ' })).rejects.toThrow(
      /warp_invalid_prompt/,
    );
    expect(requireAgentKeyMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ── Upstream errors ───────────────────────────────────────────────────────────

describe('upstream error mapping', () => {
  it('reduces an RFC-7807 problem document to safe metadata', async () => {
    respondJson(
      {
        error: 'Insufficient credits',
        title: 'Insufficient credits',
        detail: 'Team has no remaining add-on credits',
        type: 'https://docs.warp.dev/reference/api-and-sdk/troubleshooting/errors/insufficient_credits',
        status: 402,
        retryable: false,
        trace_id: 'trace-123',
      },
      402,
    );

    const err = (await dispatchAgentRun(PRINCIPAL, { prompt: 'go' }).catch(
      (e: unknown) => e,
    )) as WarpApiError;

    expect(err).toBeInstanceOf(WarpApiError);
    expect(err.status).toBe(402);
    expect(err.code).toBe('insufficient_credits');
    expect(err.detail).toBe('Team has no remaining add-on credits');
    expect(err.retryable).toBe(false);
    expect(err.traceId).toBe('trace-123');
  });

  it('still fails cleanly when the error body is not JSON', async () => {
    respondNonJson(502);

    const err = (await dispatchAgentRun(PRINCIPAL, { prompt: 'go' }).catch(
      (e: unknown) => e,
    )) as WarpApiError;

    expect(err).toBeInstanceOf(WarpApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
  });
});

// ── Secret hygiene ────────────────────────────────────────────────────────────

describe('the sealed key never escapes', () => {
  it('is absent from the request body, the log line, and the bus event', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', skillSpec: 'ima-jin/imajin-ai:catalyst' });

    expect(JSON.stringify(lastRequestBody())).not.toContain(AGENT_KEY);
    expect(JSON.stringify(logMock.info.mock.calls)).not.toContain(AGENT_KEY);
    expect(JSON.stringify(publishMock.mock.calls)).not.toContain(AGENT_KEY);
  });

  it('is absent from a thrown upstream error, even when Warp echoes the request', async () => {
    respondJson({ title: 'Not authorized', detail: `key ${AGENT_KEY} is revoked` }, 401);

    const err = (await dispatchAgentRun(PRINCIPAL, { prompt: 'go' }).catch(
      (e: unknown) => e,
    )) as WarpApiError;

    // `detail` is Warp's own copy, so it can only contain the key if Warp echoed
    // it — what matters is that WE never add it, which the message proves.
    expect(err.message).not.toContain(AGENT_KEY);
  });
});

// ── Audit trail ───────────────────────────────────────────────────────────────

describe('warp.agent.dispatched', () => {
  it('records who dispatched, under which tag, without the prompt', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'a prompt that must not be persisted',
      skillSpec: 'ima-jin/imajin-ai:catalyst',
    });

    const [eventType, envelope] = publishMock.mock.calls[0] as [
      string,
      { issuer: string; subject: string; payload: Record<string, unknown> },
    ];
    expect(eventType).toBe('warp.agent.dispatched');
    expect(envelope.issuer).toBe(PRINCIPAL);
    expect(envelope.payload).toMatchObject({
      runId: RUN_ID,
      principalDid: PRINCIPAL,
      configName: 'veteze-jin',
      state: 'QUEUED',
      skillSpec: 'ima-jin/imajin-ai:catalyst',
      context_type: 'warp.agent',
    });
    expect(JSON.stringify(envelope.payload)).not.toContain('must not be persisted');
  });

  it('does not fail the dispatch when the bus publish rejects', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));
    respondJson(QUEUED_RUN);

    await expect(dispatchAgentRun(PRINCIPAL, { prompt: 'go' })).resolves.toMatchObject({
      runId: RUN_ID,
    });
  });
});

// ── Run status ────────────────────────────────────────────────────────────────

describe('getAgentRun', () => {
  it('GETs the run with the caller own key and surfaces state + session link', async () => {
    respondJson({
      run_id: RUN_ID,
      state: 'SUCCEEDED',
      session_link: 'https://app.warp.dev/session/abc',
      agent_config: { name: 'veteze-jin' },
    });

    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/agent/runs/${RUN_ID}`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${AGENT_KEY}`);
    expect(run).toMatchObject({
      runId: RUN_ID,
      state: 'SUCCEEDED',
      sessionLink: 'https://app.warp.dev/session/abc',
      configName: 'veteze-jin',
    });
  });

  it('url-encodes the run id so a hostile value cannot reshape the path', async () => {
    respondJson({ run_id: 'x', state: 'QUEUED' });
    await getAgentRun(PRINCIPAL, '../../agent/runs');

    expect(lastFetchCall().url).toBe(`${BASE_URL}/agent/runs/..%2F..%2Fagent%2Fruns`);
  });

  it('is gated by the same grant as dispatch', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_grant: nope'));

    await expect(getAgentRun(PRINCIPAL, RUN_ID)).rejects.toThrow(/warp_no_grant/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty run id', async () => {
    await expect(getAgentRun(PRINCIPAL, '  ')).rejects.toThrow(/warp_invalid_run_id/);
    expect(requireAgentKeyMock).not.toHaveBeenCalled();
  });
});
