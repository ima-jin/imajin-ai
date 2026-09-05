/**
 * Tests for the Warp cloud-agent dispatch client (#1428).
 *
 * `fetch`, the connector gate, the identity lookup, the bus, and the logger are
 * all mocked, so these exercise the wire shape and the secret-handling
 * guarantees without touching the network, the vault, or the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  requireAgentKeyMock,
  lookupIdentityMock,
  publishMock,
  logMock,
  readEnvironmentIdMock,
  getNodeDidMock,
  searchCorpusMock,
  MockCorpusServiceError,
} = vi.hoisted(() => {
  class MockCorpusServiceError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'CorpusServiceError';
      this.status = status;
    }
  }

  return {
    requireAgentKeyMock: vi.fn(),
    lookupIdentityMock: vi.fn(),
    publishMock: vi.fn(),
    logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    readEnvironmentIdMock: vi.fn(),
    getNodeDidMock: vi.fn(),
    searchCorpusMock: vi.fn(),
    MockCorpusServiceError,
  };
});

vi.mock('../connector', () => ({
  requireAgentKey: requireAgentKeyMock,
}));

vi.mock('../../kernel/corpus-client', () => ({
  searchCorpus: searchCorpusMock,
  CorpusServiceError: MockCorpusServiceError,
}));

vi.mock('../environment', () => ({
  readEnvironmentId: readEnvironmentIdMock,
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: getNodeDidMock,
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

import {
  cancelAgentRun,
  dispatchAgentRun,
  getAgentRun,
  getAgentRunConversation,
  getAgentRunTranscript,
  listAgentRuns,
  resolveJinName,
  sendFollowup,
  WarpApiError,
} from '../dispatch';
import { CorpusContextError } from '../corpus-context';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PRINCIPAL = 'did:imajin:veteze';
const NODE_DID = 'did:imajin:this-node';
const AGENT_KEY = 'warp-agent-key-SUPER-SECRET-VALUE';
const BASE_URL = 'https://warp.test/api/v1';
const RUN_ID = '019f9990-2a46-7552-b177-3a23b17eef2e';
const OWN_ENV = 'L2DO7swtN7Ku3G7gVPwziI';
const NODE_ENV = 'NODEWIDEENVUID';

/**
 * Point the environment store at a value per DID, defaulting to "nothing stored".
 *
 * Keyed rather than sequenced because the resolution order is the thing under
 * test: a call-order-based stub would still pass if the chain looked up the wrong
 * DID.
 */
function storeEnvironments(byDid: Record<string, string>): void {
  readEnvironmentIdMock.mockImplementation(async (did: string) => byDid[did]);
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fetchCall(index: number): FetchCall {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const [url, init] = calls[index] as [string, RequestInit];
  return { url, init };
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

/** Queue an unfollowed redirect, as `redirect: 'manual'` surfaces one. */
function respondRedirect(location: string, status = 302): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: false,
    status,
    statusText: 'Found',
    headers: new Headers(location.length === 0 ? {} : { location }),
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response);
}

/** Queue a text/plain response, as the transcript download answers. */
function respondText(body: string, contentType = 'text/plain', status = 200): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Test',
    headers: new Headers({ 'content-type': contentType }),
    text: async () => body,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response);
}

/** Queue a 200 with no body at all, as the mutation endpoints may answer. */
function respondEmpty(): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => {
      throw new Error('unexpected end of JSON input');
    },
  } as unknown as Response);
}

const QUEUED_RUN = { run_id: RUN_ID, state: 'QUEUED' };

beforeEach(() => {
  process.env.WARP_API_BASE_URL = BASE_URL;

  requireAgentKeyMock.mockReset().mockResolvedValue(AGENT_KEY);
  lookupIdentityMock.mockReset().mockResolvedValue({ did: PRINCIPAL, handle: 'veteze' });
  publishMock.mockReset().mockResolvedValue(undefined);
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();

  readEnvironmentIdMock.mockReset();
  storeEnvironments({});
  getNodeDidMock.mockReset().mockResolvedValue(NODE_DID);
  searchCorpusMock.mockReset();

  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.WARP_API_BASE_URL;
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

// ── Conversation/parent lineage passthrough (#1939) ───────────────────────────

describe('dispatch lineage passthrough', () => {
  it('sends conversationId as top-level conversation_id, not inside config', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', conversationId: 'conv-123' });

    expect(lastRequestBody().conversation_id).toBe('conv-123');
    expect(lastConfig()).not.toHaveProperty('conversation_id');
  });

  it('sends parentRunId as top-level parent_run_id, not inside config', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', parentRunId: 'run-parent-1' });

    expect(lastRequestBody().parent_run_id).toBe('run-parent-1');
    expect(lastConfig()).not.toHaveProperty('parent_run_id');
  });

  it('omits both lineage fields when neither is given', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastRequestBody()).not.toHaveProperty('conversation_id');
    expect(lastRequestBody()).not.toHaveProperty('parent_run_id');
  });
});

// ── Environment resolution (#1632) ───────────────────────────────────────────
//
// The default used to be a single node-wide env var. It is now resolved from
// DIDs — caller first, then the node — so these pin the order, and pin that a
// missing or broken default degrades rather than failing the run.

describe('environment resolution is DID-keyed', () => {
  it('uses the caller stored default when the dispatch names none', async () => {
    storeEnvironments({ [PRINCIPAL]: OWN_ENV });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig().environment_id).toBe(OWN_ENV);
  });

  it('prefers an explicit environment over every stored default', async () => {
    storeEnvironments({ [PRINCIPAL]: OWN_ENV, [NODE_DID]: NODE_ENV });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', environmentId: 'UAEXPLICIT' });

    expect(lastConfig().environment_id).toBe('UAEXPLICIT');
  });

  it('falls back to the node DID default when the caller has none', async () => {
    storeEnvironments({ [NODE_DID]: NODE_ENV });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig().environment_id).toBe(NODE_ENV);
  });

  it('prefers the caller own default over the node default', async () => {
    storeEnvironments({ [PRINCIPAL]: OWN_ENV, [NODE_DID]: NODE_ENV });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig().environment_id).toBe(OWN_ENV);
  });

  it('omits environment_id entirely when no DID has a default', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig()).not.toHaveProperty('environment_id');
  });

  it('does not read the node default twice when the caller IS the node', async () => {
    storeEnvironments({ [NODE_DID]: NODE_ENV });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(NODE_DID, { prompt: 'go' });

    expect(lastConfig().environment_id).toBe(NODE_ENV);
    expect(readEnvironmentIdMock).toHaveBeenCalledTimes(1);
  });

  it('skips the node lookup entirely when the dispatch names an environment', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', environmentId: 'UAEXPLICIT' });

    expect(readEnvironmentIdMock).not.toHaveBeenCalled();
    expect(getNodeDidMock).not.toHaveBeenCalled();
  });

  it('dispatches without an environment when the node DID is unresolvable', async () => {
    getNodeDidMock.mockResolvedValue('');
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(lastConfig()).not.toHaveProperty('environment_id');
  });

  it('still dispatches when resolving the node DID throws', async () => {
    // A preference lookup must never take down an authorized run.
    getNodeDidMock.mockRejectedValue(new Error('relay_config unreachable'));
    respondJson(QUEUED_RUN);

    const run = await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(run.runId).toBe(RUN_ID);
    expect(lastConfig()).not.toHaveProperty('environment_id');
  });

  it('records the resolved environment on the bus event for the audit trail', async () => {
    storeEnvironments({ [NODE_DID]: NODE_ENV });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    const [, event] = publishMock.mock.calls[0] as [string, { payload: { environmentId: unknown } }];
    expect(event.payload.environmentId).toBe(NODE_ENV);
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

// ── Corpus context (#2021's "one real consumer" checklist item) ──────────────

const CORPUS_HIT = {
  source: 'github:ima-jin/imajin-ai',
  id: '123',
  type: 'issue',
  title: 'Fix the login error',
  state: 'open',
  score: 0.834,
  evidence: ['a prior quote about the login error'],
  updated: '2026-08-01T00:00:00Z',
};

function lastSearchCorpusCall(): [string, Record<string, unknown>] {
  return searchCorpusMock.mock.calls.at(-1) as [string, Record<string, unknown>];
}

describe('dispatch corpusContext', () => {
  it('never searches corpus when corpusContext is omitted', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    expect(searchCorpusMock).not.toHaveBeenCalled();
    expect(lastRequestBody().prompt).toBe('go');
  });

  it('prepends a provenance-stamped context block ahead of the unchanged prompt', async () => {
    searchCorpusMock.mockResolvedValue({ results: [CORPUS_HIT], totalHits: 1, tokensUsed: 10 });
    respondJson(QUEUED_RUN);

    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'Fix it',
      corpusContext: { source: 'github:ima-jin/imajin-ai', query: 'login error' },
    });

    const prompt = lastRequestBody().prompt as string;
    expect(prompt).toContain('## Retrieved context (corpus)');
    expect(prompt).toContain('source=github:ima-jin/imajin-ai ref=unpinned hits=1');
    expect(prompt).toContain('Fix the login error');
    expect(prompt.endsWith('---\n\nFix it')).toBe(true);
  });

  it('always searches the acting principal\'s own DID, never one implied by corpusContext', async () => {
    searchCorpusMock.mockResolvedValue({ results: [], totalHits: 0, tokensUsed: 0 });
    respondJson(QUEUED_RUN);

    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      // corpusContext has no `did` field in the type at all; this simulates a
      // caller trying to smuggle one in anyway via an untyped body.
      corpusContext: { source: 's', query: 'q', did: 'did:imajin:someone-else' } as never,
    });

    const [did, params] = lastSearchCorpusCall();
    expect(did).toBe(PRINCIPAL);
    expect(params).not.toHaveProperty('did');
  });

  it('defaults limit to 8 and clamps an out-of-range limit to 20', async () => {
    searchCorpusMock.mockResolvedValue({ results: [], totalHits: 0, tokensUsed: 0 });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go', corpusContext: { source: 's', query: 'q' } });
    expect(lastSearchCorpusCall()[1]).toMatchObject({ limit: 8 });

    searchCorpusMock.mockResolvedValue({ results: [], totalHits: 0, tokensUsed: 0 });
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      corpusContext: { source: 's', query: 'q', limit: 500 },
    });
    expect(lastSearchCorpusCall()[1]).toMatchObject({ limit: 20 });
  });

  it('passes ref through to the corpus search when given', async () => {
    searchCorpusMock.mockResolvedValue({ results: [], totalHits: 0, tokensUsed: 0 });
    respondJson(QUEUED_RUN);

    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      corpusContext: { source: 's', query: 'q', ref: 'deadbeef' },
    });

    expect(lastSearchCorpusCall()[1]).toMatchObject({ ref: 'deadbeef' });
  });

  it('records source/ref/hits/contentHashes/retrievedAt on warp.agent.dispatched, never the snippet text', async () => {
    searchCorpusMock.mockResolvedValue({
      results: [{ ...CORPUS_HIT, contentHash: 'sha256:abc123' }],
      totalHits: 1,
      tokensUsed: 10,
    });
    respondJson(QUEUED_RUN);

    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      corpusContext: { source: 'github:ima-jin/imajin-ai', query: 'q', ref: 'deadbeef' },
    });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload.corpusContext).toMatchObject({
      source: 'github:ima-jin/imajin-ai',
      ref: 'deadbeef',
      hits: 1,
      contentHashes: ['sha256:abc123'],
    });
    expect(JSON.stringify(envelope.payload)).not.toContain('a prior quote about the login error');
  });

  it('records a null corpusContext on the audit event when none was requested', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload.corpusContext).toBeNull();
  });

  // ── Failure modes: fail closed, no run is ever created ──

  it('fails the whole dispatch when corpus is unreachable, and creates no run', async () => {
    searchCorpusMock.mockRejectedValue(new Error('fetch failed: connection refused'));

    await expect(
      dispatchAgentRun(PRINCIPAL, { prompt: 'go', corpusContext: { source: 's', query: 'q' } }),
    ).rejects.toThrow(/corpus_context_failed/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('maps a corpus 401 (bad access claim) to a 400-class CorpusContextError, and creates no run', async () => {
    searchCorpusMock.mockRejectedValue(new MockCorpusServiceError(401, 'invalid claim'));

    const err = (await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      corpusContext: { source: 's', query: 'q' },
    }).catch((e: unknown) => e)) as CorpusContextError;

    expect(err).toBeInstanceOf(CorpusContextError);
    expect(err.status).toBe(400);
    expect(err.corpusStatus).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps a corpus 404 (unknown ref) to a 400-class CorpusContextError, and creates no run', async () => {
    searchCorpusMock.mockRejectedValue(new MockCorpusServiceError(404, 'no indexed snapshot for that ref'));

    const err = (await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      corpusContext: { source: 's', query: 'q', ref: 'unknown-sha' },
    }).catch((e: unknown) => e)) as CorpusContextError;

    expect(err.status).toBe(400);
    expect(err.corpusStatus).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps a corpus 500 to a 502-class CorpusContextError, and creates no run', async () => {
    searchCorpusMock.mockRejectedValue(new MockCorpusServiceError(500, 'internal error'));

    const err = (await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      corpusContext: { source: 's', query: 'q' },
    }).catch((e: unknown) => e)) as CorpusContextError;

    expect(err.status).toBe(502);
    expect(err.corpusStatus).toBe(500);
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

  it('records the Warp-confirmed conversation and parent lineage (#1939)', async () => {
    respondJson({ ...QUEUED_RUN, conversation_id: 'conv-123', parent_run_id: 'run-parent-1' });
    await dispatchAgentRun(PRINCIPAL, {
      prompt: 'go',
      conversationId: 'conv-123',
      parentRunId: 'run-parent-1',
    });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload).toMatchObject({
      conversationId: 'conv-123',
      parentRunId: 'run-parent-1',
    });
  });

  it('records null lineage when the dispatch named neither', async () => {
    respondJson(QUEUED_RUN);
    await dispatchAgentRun(PRINCIPAL, { prompt: 'go' });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload).toMatchObject({ conversationId: null, parentRunId: null });
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

// ── Full run parse (#1639) ────────────────────────────────────────────────────
//
// The response always carried these; we only read five of them. These pin the
// rest, and pin that each one degrades to null rather than failing the read.

describe('getAgentRun parses the whole run body', () => {
  const FULL_RUN = {
    run_id: RUN_ID,
    state: 'FAILED',
    session_link: 'https://app.warp.dev/session/abc',
    title: 'Nightly',
    created_at: '2026-08-05T10:00:00Z',
    started_at: '2026-08-05T10:00:05Z',
    updated_at: '2026-08-05T10:02:35Z',
    run_time: 'PT2M30S',
    status_message: {
      message: 'Team has no remaining add-on credits',
      error_code: 'insufficient_credits',
      retryable: false,
    },
    source: 'API',
    execution_location: 'REMOTE',
    session_id: 'session-uuid',
    conversation_id: 'conversation-uuid',
    parent_run_id: 'parent-uuid',
    trigger_url: 'https://linear.app/issue/ABC-1',
    is_sandbox_running: true,
    request_usage: { inference_cost: 0.42, compute_cost: 0.1, platform_cost: 0 },
    creator: { type: 'service_account', uid: 'sa-1', display_name: 'veteze-jin' },
    executor: { type: 'user', uid: 'u-1', display_name: 'Veteze' },
    agent_config: {
      name: 'veteze-jin',
      model_id: 'auto',
      environment_id: OWN_ENV,
      skill_spec: 'ima-jin/imajin-ai:catalyst',
    },
    agent_skill: { name: 'catalyst', full_path: '.warp/skills/catalyst/SKILL.md' },
    schedule: { schedule_id: 's-1', schedule_name: 'nightly', cron_schedule: '0 3 * * *' },
    artifacts: [
      {
        artifact_type: 'PULL_REQUEST',
        created_at: '2026-08-05T10:02:00Z',
        data: { url: 'https://github.com/ima-jin/imajin-ai/pull/1638', branch: 'fix/1630' },
      },
    ],
  };

  it('surfaces the lifecycle timestamps and the server-computed run time', async () => {
    respondJson(FULL_RUN);
    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    expect(run).toMatchObject({
      createdAt: '2026-08-05T10:00:00Z',
      startedAt: '2026-08-05T10:00:05Z',
      updatedAt: '2026-08-05T10:02:35Z',
      runTime: 'PT2M30S',
    });
  });

  it('surfaces the structured status message that explains a failure', async () => {
    respondJson(FULL_RUN);
    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    expect(run.statusMessage).toEqual({
      message: 'Team has no remaining add-on credits',
      errorCode: 'insufficient_credits',
      retryable: false,
    });
  });

  it('surfaces provenance, cost, and the resolved config', async () => {
    respondJson(FULL_RUN);
    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    expect(run).toMatchObject({
      source: 'API',
      executionLocation: 'REMOTE',
      sessionId: 'session-uuid',
      conversationId: 'conversation-uuid',
      parentRunId: 'parent-uuid',
      triggerUrl: 'https://linear.app/issue/ABC-1',
      isSandboxRunning: true,
      modelId: 'auto',
      environmentId: OWN_ENV,
      skillSpec: 'ima-jin/imajin-ai:catalyst',
    });
    expect(run.requestUsage).toEqual({ inferenceCost: 0.42, computeCost: 0.1, platformCost: 0 });
    expect(run.creator).toEqual({
      type: 'service_account',
      uid: 'sa-1',
      displayName: 'veteze-jin',
    });
    expect(run.executor?.displayName).toBe('Veteze');
    expect(run.agentSkill).toEqual({
      name: 'catalyst',
      fullPath: '.warp/skills/catalyst/SKILL.md',
      bundledSkillId: null,
    });
    expect(run.schedule?.cronSchedule).toBe('0 3 * * *');
  });

  it('surfaces the pull request artifact, which is the PR linkage', async () => {
    respondJson(FULL_RUN);
    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]).toMatchObject({
      artifactType: 'PULL_REQUEST',
      data: { url: 'https://github.com/ima-jin/imajin-ai/pull/1638', branch: 'fix/1630' },
    });
  });

  it('never surfaces the prompt, so a run stays safe to log and publish', async () => {
    respondJson({ ...FULL_RUN, prompt: 'a prompt that must not be persisted' });
    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    expect(run).not.toHaveProperty('prompt');
    expect(JSON.stringify(run)).not.toContain('must not be persisted');
  });

  it('degrades every absent or malformed field to null rather than throwing', async () => {
    respondJson({
      run_id: RUN_ID,
      state: 'QUEUED',
      status_message: { error_code: 'invalid_request' },
      request_usage: 'not an object',
      creator: [],
      artifacts: ['not an object'],
    });

    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    expect(run).toMatchObject({
      createdAt: null,
      startedAt: null,
      runTime: null,
      // No `message` means there is nothing to report, so the whole field is null.
      statusMessage: null,
      requestUsage: null,
      creator: null,
      artifacts: [],
    });
  });

  it('reads a config that arrived under `config` rather than `agent_config`', async () => {
    respondJson({ run_id: RUN_ID, config: { name: 'veteze-jin', model_id: 'auto' } });
    const run = await getAgentRun(PRINCIPAL, RUN_ID);

    expect(run).toMatchObject({ configName: 'veteze-jin', modelId: 'auto' });
  });
});

// ── Transcript (#1639) ────────────────────────────────────────────────────────

describe('getAgentRunTranscript', () => {
  const DOWNLOAD_URL = 'https://storage.warp.test/transcripts/abc?signature=xyz';

  it('asks Warp not to follow the redirect, then downloads the transcript', async () => {
    respondRedirect(DOWNLOAD_URL);
    respondText('user: go\nassistant: done');

    const transcript = await getAgentRunTranscript(PRINCIPAL, RUN_ID);

    const api = fetchCall(0);
    expect(api.url).toBe(`${BASE_URL}/agent/runs/${RUN_ID}/transcript`);
    expect(api.init.redirect).toBe('manual');
    expect(fetchCall(1).url).toBe(DOWNLOAD_URL);
    expect(transcript).toMatchObject({
      runId: RUN_ID,
      content: 'user: go\nassistant: done',
      contentType: 'text/plain',
      truncated: false,
    });
  });

  it('never presents the sealed key to the pre-signed download URL', async () => {
    respondRedirect(DOWNLOAD_URL);
    respondText('transcript');

    await getAgentRunTranscript(PRINCIPAL, RUN_ID);

    // The signature is the credential on that host; ours has no business there.
    expect(fetchCall(1).init).toBeUndefined();
    expect(JSON.stringify(vi.mocked(globalThis.fetch).mock.calls[1])).not.toContain(AGENT_KEY);
  });

  it('reads a transcript served inline instead of via a redirect', async () => {
    respondText('inline transcript', 'application/json');

    const transcript = await getAgentRunTranscript(PRINCIPAL, RUN_ID);

    expect(transcript.content).toBe('inline transcript');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('truncates at the cap and says so rather than returning an unbounded body', async () => {
    respondRedirect(DOWNLOAD_URL);
    respondText('0123456789');

    const transcript = await getAgentRunTranscript(PRINCIPAL, RUN_ID, { maxChars: 4 });

    expect(transcript.content).toBe('0123');
    expect(transcript.truncated).toBe(true);
  });

  it('fails as an upstream fault when the redirect carries no Location', async () => {
    respondRedirect('');

    const err = (await getAgentRunTranscript(PRINCIPAL, RUN_ID).catch(
      (e: unknown) => e,
    )) as WarpApiError;

    expect(err).toBeInstanceOf(WarpApiError);
    expect(err.status).toBe(502);
  });

  it('maps a failed download to the status the storage host reported', async () => {
    respondRedirect(DOWNLOAD_URL);
    respondText('expired', 'text/plain', 403);

    const err = (await getAgentRunTranscript(PRINCIPAL, RUN_ID).catch(
      (e: unknown) => e,
    )) as WarpApiError;

    expect(err.status).toBe(403);
  });

  it('maps a Warp problem document from the transcript endpoint itself', async () => {
    respondJson({ title: 'Not found', type: '…/errors/resource_not_found' }, 404);

    const err = (await getAgentRunTranscript(PRINCIPAL, RUN_ID).catch(
      (e: unknown) => e,
    )) as WarpApiError;

    expect(err.status).toBe(404);
    expect(err.code).toBe('resource_not_found');
  });

  it('is gated by the same grant, and rejects a blank run id first', async () => {
    await expect(getAgentRunTranscript(PRINCIPAL, ' ')).rejects.toThrow(/warp_invalid_run_id/);
    expect(requireAgentKeyMock).not.toHaveBeenCalled();

    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_grant: nope'));
    await expect(getAgentRunTranscript(PRINCIPAL, RUN_ID)).rejects.toThrow(/warp_no_grant/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ── Conversation (#1639) ──────────────────────────────────────────────────────

describe('getAgentRunConversation', () => {
  it('GETs the normalized conversation and passes the step tree through', async () => {
    respondJson({
      conversation_id: 'conversation-uuid',
      steps: [
        {
          id: 'step-1',
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
            {
              role: 'tool',
              content: [
                { type: 'action', id: 'a1', category: 'COMMAND', name: 'run_command', input: {} },
              ],
            },
          ],
          steps: [],
        },
      ],
    });

    const conversation = await getAgentRunConversation(PRINCIPAL, RUN_ID);

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/agent/runs/${RUN_ID}/conversation`);
    expect(init.method).toBe('GET');
    expect(conversation.conversationId).toBe('conversation-uuid');
    expect(conversation.steps[0].messages[1].content[0]).toMatchObject({
      type: 'action',
      name: 'run_command',
    });
  });

  it('returns an empty step list rather than null when there is nothing to walk', async () => {
    respondJson({ conversation_id: 'c1' });
    const conversation = await getAgentRunConversation(PRINCIPAL, RUN_ID);

    expect(conversation.steps).toEqual([]);
  });

  it('treats a non-object payload as an upstream fault', async () => {
    respondJson('not a conversation');

    const err = (await getAgentRunConversation(PRINCIPAL, RUN_ID).catch(
      (e: unknown) => e,
    )) as WarpApiError;

    expect(err).toBeInstanceOf(WarpApiError);
    expect(err.status).toBe(502);
  });

  it('url-encodes the run id so a hostile value cannot reshape the path', async () => {
    respondJson({ steps: [] });
    await getAgentRunConversation(PRINCIPAL, '../../agent/runs');

    expect(lastFetchCall().url).toBe(
      `${BASE_URL}/agent/runs/..%2F..%2Fagent%2Fruns/conversation`,
    );
  });
});

// ── Run history (#1639) ───────────────────────────────────────────────────────

describe('listAgentRuns', () => {
  it('GETs /agent/runs with no query when no filters are given', async () => {
    respondJson({ runs: [], page_info: { has_next_page: false } });
    await listAgentRuns(PRINCIPAL);

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/agent/runs`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${AGENT_KEY}`);
  });

  it('repeats `state` rather than comma-joining it, which is the only shape Warp reads', async () => {
    respondJson({ runs: [], page_info: { has_next_page: false } });
    await listAgentRuns(PRINCIPAL, { states: ['QUEUED', 'INPROGRESS'] });

    const query = new URL(lastFetchCall().url).searchParams;
    expect(query.getAll('state')).toEqual(['QUEUED', 'INPROGRESS']);
  });

  it('maps the documented filters onto Warp snake_case parameters', async () => {
    respondJson({ runs: [], page_info: { has_next_page: false } });
    await listAgentRuns(PRINCIPAL, {
      name: 'veteze-jin',
      environmentId: OWN_ENV,
      createdAfter: '2026-08-01T00:00:00Z',
      cursor: 'cursor-1',
    });

    const query = new URL(lastFetchCall().url).searchParams;
    expect(query.get('name')).toBe('veteze-jin');
    expect(query.get('environment_id')).toBe(OWN_ENV);
    expect(query.get('created_after')).toBe('2026-08-01T00:00:00Z');
    expect(query.get('cursor')).toBe('cursor-1');
  });

  it('clamps an out-of-range page size instead of failing the read', async () => {
    respondJson({ runs: [], page_info: { has_next_page: false } });
    await listAgentRuns(PRINCIPAL, { limit: 5000 });
    expect(new URL(lastFetchCall().url).searchParams.get('limit')).toBe('500');

    respondJson({ runs: [], page_info: { has_next_page: false } });
    await listAgentRuns(PRINCIPAL, { limit: 0 });
    expect(new URL(lastFetchCall().url).searchParams.get('limit')).toBe('1');
  });

  it('returns the parsed runs and the pagination cursor', async () => {
    respondJson({
      runs: [
        { run_id: 'run-1', state: 'SUCCEEDED', run_time: 'PT10S' },
        { run_id: 'run-2', state: 'QUEUED' },
      ],
      page_info: { has_next_page: true, next_cursor: 'cursor-2' },
    });

    const page = await listAgentRuns(PRINCIPAL, { name: 'veteze-jin' });

    expect(page.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2']);
    expect(page.runs[0].runTime).toBe('PT10S');
    expect(page).toMatchObject({ hasNextPage: true, nextCursor: 'cursor-2' });
  });

  it('skips an item with no run id rather than losing the whole page', async () => {
    respondJson({
      runs: [{ state: 'QUEUED' }, { run_id: 'run-2', state: 'QUEUED' }],
      page_info: { has_next_page: false },
    });

    const page = await listAgentRuns(PRINCIPAL);

    expect(page.runs.map((run) => run.runId)).toEqual(['run-2']);
    expect(page.nextCursor).toBeNull();
  });

  it('treats a non-object payload as an upstream fault', async () => {
    respondJson([]);

    const err = (await listAgentRuns(PRINCIPAL).catch((e: unknown) => e)) as WarpApiError;

    expect(err).toBeInstanceOf(WarpApiError);
    expect(err.status).toBe(502);
  });

  it('is gated by the same grant as dispatch', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_grant: nope'));

    await expect(listAgentRuns(PRINCIPAL)).rejects.toThrow(/warp_no_grant/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('passes ancestorRunId through as ancestor_run_id (#1939)', async () => {
    respondJson({ runs: [], page_info: { has_next_page: false } });
    await listAgentRuns(PRINCIPAL, { ancestorRunId: 'run-ancestor-1' });

    const query = new URL(lastFetchCall().url).searchParams;
    expect(query.get('ancestor_run_id')).toBe('run-ancestor-1');
  });
});

// ── Cancel (#1639) ────────────────────────────────────────────────────────────

describe('cancelAgentRun', () => {
  it('POSTs to the cancel endpoint with the caller own key', async () => {
    respondJson(RUN_ID);

    const result = await cancelAgentRun(PRINCIPAL, RUN_ID);

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/agent/runs/${RUN_ID}/cancel`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${AGENT_KEY}`);
    expect(result).toEqual({ runId: RUN_ID, cancelled: true });
  });

  it('succeeds when Warp answers 200 with no parseable body', async () => {
    respondEmpty();

    await expect(cancelAgentRun(PRINCIPAL, RUN_ID)).resolves.toEqual({
      runId: RUN_ID,
      cancelled: true,
    });
  });

  it('surfaces the PENDING conflict as retryable rather than flattening it', async () => {
    respondJson(
      {
        title: 'Conflict',
        type: '…/errors/conflict',
        retryable: true,
      },
      409,
    );

    const err = (await cancelAgentRun(PRINCIPAL, RUN_ID).catch((e: unknown) => e)) as WarpApiError;

    expect(err.status).toBe(409);
    expect(err.code).toBe('conflict');
    expect(err.retryable).toBe(true);
  });

  it('rejects a blank run id before unwrapping the credential', async () => {
    await expect(cancelAgentRun(PRINCIPAL, '   ')).rejects.toThrow(/warp_invalid_run_id/);
    expect(requireAgentKeyMock).not.toHaveBeenCalled();
  });

  it('surfaces a run type Warp cannot cancel at all as unsupported, not retryable', async () => {
    respondJson(
      {
        title: 'Unprocessable',
        type: '…/errors/operation_not_supported',
        retryable: false,
      },
      422,
    );

    const err = (await cancelAgentRun(PRINCIPAL, RUN_ID).catch((e: unknown) => e)) as WarpApiError;

    expect(err.status).toBe(422);
    expect(err.code).toBe('operation_not_supported');
    expect(err.retryable).toBe(false);
  });

  it('is gated by the same grant as dispatch', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_grant: nope'));

    await expect(cancelAgentRun(PRINCIPAL, RUN_ID)).rejects.toThrow(/warp_no_grant/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('is gated by the same sealed key as dispatch', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_secret: nothing sealed'));

    await expect(cancelAgentRun(PRINCIPAL, RUN_ID)).rejects.toThrow(/warp_no_secret/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ── Follow-ups (#1639) ────────────────────────────────────────────────────────────────────────────
//
// Every follow-up first reads the run's current state (#1939), so a run fixture
// is queued before the followups ack in every test below except the ones that
// fail before ever reaching the network.

const INPROGRESS_RUN = { run_id: RUN_ID, state: 'INPROGRESS' };

describe('sendFollowup', () => {
  it('POSTs the trimmed message to the followups endpoint', async () => {
    respondJson(INPROGRESS_RUN);
    respondJson({});

    const ack = await sendFollowup(PRINCIPAL, RUN_ID, { message: '  use pnpm, not npm  ' });

    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/agent/runs/${RUN_ID}/followups`);
    expect(init.method).toBe('POST');
    expect(lastRequestBody()).toEqual({ message: 'use pnpm, not npm' });
    expect(ack).toEqual({ runId: RUN_ID, accepted: true });
  });

  it('reads the run state first, with the same key, before delivering', async () => {
    respondJson(INPROGRESS_RUN);
    respondJson({});
    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'carry on' });

    const first = fetchCall(0);
    expect(first.url).toBe(`${BASE_URL}/agent/runs/${RUN_ID}`);
    expect(first.init.method).toBe('GET');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it('forwards an explicit mode, since Warp does not infer it from the message', async () => {
    respondJson(INPROGRESS_RUN);
    respondJson({});
    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'replan', mode: 'plan' });

    expect(lastRequestBody()).toMatchObject({ mode: 'plan' });
  });

  it('omits mode entirely when the caller names none', async () => {
    respondJson(INPROGRESS_RUN);
    respondJson({});
    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'carry on' });

    expect(lastRequestBody()).not.toHaveProperty('mode');
  });

  it('rejects an unknown mode rather than letting it silently downgrade', async () => {
    await expect(
      sendFollowup(PRINCIPAL, RUN_ID, {
        message: 'go',
        mode: 'yolo' as unknown as 'normal',
      }),
    ).rejects.toThrow(/warp_invalid_mode/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty message before making a network call', async () => {
    await expect(sendFollowup(PRINCIPAL, RUN_ID, { message: '   ' })).rejects.toThrow(
      /warp_invalid_message/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('is gated by the same grant as dispatch', async () => {
    requireAgentKeyMock.mockRejectedValue(new Error('warp_no_secret: nothing sealed'));

    await expect(sendFollowup(PRINCIPAL, RUN_ID, { message: 'go' })).rejects.toThrow(
      /warp_no_secret/,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps the sealed key out of the request body and the log line', async () => {
    respondJson(INPROGRESS_RUN);
    respondJson({});
    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'go', mode: 'normal' });

    expect(JSON.stringify(lastRequestBody())).not.toContain(AGENT_KEY);
    expect(JSON.stringify(logMock.info.mock.calls)).not.toContain(AGENT_KEY);
  });
});

// ── Terminal-run refusal vs. resume (#1939) ───────────────────────────────────────

describe('sendFollowup terminal-run resume', () => {
  it('refuses a terminal run without resume, and never delivers the follow-up', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED' });

    await expect(sendFollowup(PRINCIPAL, RUN_ID, { message: 'go' })).rejects.toThrow(
      /warp_run_terminal/,
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('refuses a terminal run when resume is explicitly false', async () => {
    respondJson({ run_id: RUN_ID, state: 'FAILED' });

    await expect(
      sendFollowup(PRINCIPAL, RUN_ID, { message: 'go', resume: false }),
    ).rejects.toThrow(/warp_run_terminal/);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('does not refuse a non-terminal run even without resume', async () => {
    respondJson(INPROGRESS_RUN);
    respondJson({});

    await expect(sendFollowup(PRINCIPAL, RUN_ID, { message: 'go' })).resolves.toEqual({
      runId: RUN_ID,
      accepted: true,
    });
  });

  it('proxies the follow-up to a terminal run when resume is true', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED' });
    respondJson({});

    const ack = await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true });

    expect(ack).toEqual({ runId: RUN_ID, accepted: true });
    const { url, init } = lastFetchCall();
    expect(url).toBe(`${BASE_URL}/agent/runs/${RUN_ID}/followups`);
    expect(init.method).toBe('POST');
    expect(lastRequestBody()).toEqual({ message: 'keep going' });
  });

  it('records the resume on the bus as the honest kernel run record', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED', session_id: 'session-a' });
    respondJson({});

    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', mode: 'plan', resume: true });

    const [eventType, envelope] = publishMock.mock.calls[0] as [
      string,
      { issuer: string; payload: Record<string, unknown> },
    ];
    expect(eventType).toBe('warp.run.resumed');
    expect(envelope.issuer).toBe(PRINCIPAL);
    expect(envelope.payload).toMatchObject({
      runId: RUN_ID,
      principalDid: PRINCIPAL,
      previousState: 'SUCCEEDED',
      // The prior segment's sessionId, read from the pre-resume state check
      // (#2032) — this is what lets a later completion carry `resumedFrom`.
      previousSessionId: 'session-a',
      mode: 'plan',
      context_type: 'warp.agent',
    });
  });

  it('records null previousSessionId when the run carried none', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED' });
    respondJson({});

    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload.previousSessionId).toBeNull();
  });

  it('records newSessionId from the followups response when Warp returns one, else null (#2032)', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED', session_id: 'session-a' });
    respondJson({ session_id: 'session-b' });

    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload.newSessionId).toBe('session-b');
  });

  it('records a null newSessionId when the followups response carries none', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED', session_id: 'session-a' });
    respondJson({});

    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload.newSessionId).toBeNull();
  });

  it('defaults the recorded resume mode to normal when none was given', async () => {
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED' });
    respondJson({});

    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true });

    const [, envelope] = publishMock.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    expect(envelope.payload.mode).toBe('normal');
  });

  it('does not publish a resume event for a non-terminal run, even with resume: true', async () => {
    respondJson(INPROGRESS_RUN);
    respondJson({});

    await sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true });

    expect(publishMock).not.toHaveBeenCalled();
  });

  it('does not fail the follow-up when the resume bus publish rejects', async () => {
    publishMock.mockRejectedValue(new Error('bus down'));
    respondJson({ run_id: RUN_ID, state: 'SUCCEEDED' });
    respondJson({});

    await expect(
      sendFollowup(PRINCIPAL, RUN_ID, { message: 'keep going', resume: true }),
    ).resolves.toEqual({ runId: RUN_ID, accepted: true });
  });
});
