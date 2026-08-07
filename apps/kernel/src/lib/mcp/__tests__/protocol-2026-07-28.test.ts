/**
 * MCP `2026-07-28` conformance (#1474).
 *
 * These lock in the shape of the DUAL-ERA server. The failure mode worth
 * guarding against is not "we forgot a version string" — it is the opposite:
 * declaring support for 2026-07-28 while still speaking the handshake protocol
 * that revision deleted. So most of what follows asserts the two eras stay
 * separated: a legacy `initialize` must never be answered with `2026-07-28`,
 * and a modern request must never reach `initialize`/`ping`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tool registry so dispatch can be exercised without pulling in the
// db-backed tools. Mirrors scope-gate.test.ts; the REAL dispatch runs.
vi.mock('../tools', () => {
  const tools = [
    {
      name: 't_read',
      requiredScope: 'media:read',
      description: 'r',
      inputSchema: { type: 'object' },
      handler: () => [{ type: 'text', text: 'read-ok' }],
    },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { ALL_TOOLS: tools, toolByName: (n: string) => byName.get(n) };
});

const mockResolveGrant = vi.hoisted(() => vi.fn<(did: string, scope: string) => Promise<boolean>>());
vi.mock('../mcp-grant', () => ({
  resolveActiveMcpGrant: (...args: [string, string]) => mockResolveGrant(...args),
}));

import { handleMcpRpc } from '../server';
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  LIST_CACHE_SCOPE,
  LIST_CACHE_TTL_MS,
  MCP_ERROR_HEADER_MISMATCH,
  MCP_ERROR_METHOD_NOT_FOUND,
  MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  httpStatusForModernResponse,
  isModernProtocolVersion,
  isSupportedProtocolVersion,
  negotiateProtocol,
  readRequestProtocolVersion,
  validateModernRequestHeaders,
} from '../protocol';

const MODERN = '2026-07-28';
const CTX = { did: 'did:imajin:user', appDid: 'did:imajin:app', scopes: new Set(['media:read']) };

/** A modern request: protocol version + client capabilities in `params._meta`. */
function modern(method: string, params: Record<string, unknown> = {}, version = MODERN) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        [META_PROTOCOL_VERSION]: version,
        'io.modelcontextprotocol/clientInfo': { name: 'TestClient', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

/** A legacy request: no `_meta`, version comes from the `initialize` handshake. */
function legacy(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0' as const, id: 1, method, params };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dispatch = (msg: unknown) => handleMcpRpc(msg as any, CTX) as Promise<any>;

beforeEach(() => {
  mockResolveGrant.mockReset();
  mockResolveGrant.mockResolvedValue(false);
});

describe('supported protocol versions', () => {
  it('speaks 2026-07-28 and advertises it first', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe(MODERN);
    expect(SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(MODERN);
    expect(isSupportedProtocolVersion(MODERN)).toBe(true);
  });

  it('still speaks the legacy revisions it shipped with', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-06-18');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-03-26');
  });

  it('classifies 2026-07-28 as modern and the 2025 revisions as not', () => {
    expect(isModernProtocolVersion(MODERN)).toBe(true);
    expect(isModernProtocolVersion('2025-06-18')).toBe(false);
    expect(isModernProtocolVersion('2025-03-26')).toBe(false);
    expect(isModernProtocolVersion(undefined)).toBe(false);
  });

  it('reports the protocol bump in serverInfo', () => {
    expect(SERVER_INFO.version).toBe('0.2.0');
  });
});

describe('legacy initialize negotiation', () => {
  it('echoes a legacy version the client asks for', async () => {
    const res = await dispatch(legacy('initialize', { protocolVersion: '2025-03-26' }));
    expect(res.result.protocolVersion).toBe('2025-03-26');
  });

  it('falls back to the default legacy version when none is requested', async () => {
    const res = await dispatch(legacy('initialize', {}));
    expect(res.result.protocolVersion).toBe(DEFAULT_LEGACY_PROTOCOL_VERSION);
    expect(res.result.protocolVersion).toBe('2025-06-18');
  });

  /**
   * The trap this whole change exists to avoid. `initialize` does not exist in
   * 2026-07-28, so answering a handshake with that version would tell a legacy
   * client we speak a protocol in which the message it just sent was removed.
   */
  it('never answers a handshake with 2026-07-28, even if asked for it', async () => {
    const res = await dispatch(legacy('initialize', { protocolVersion: MODERN }));
    expect(res.result.protocolVersion).not.toBe(MODERN);
    expect(res.result.protocolVersion).toBe(DEFAULT_LEGACY_PROTOCOL_VERSION);
    expect(negotiateProtocol(MODERN)).toBe(DEFAULT_LEGACY_PROTOCOL_VERSION);
  });

  it('keeps the legacy capabilities + serverInfo shape', async () => {
    const res = await dispatch(legacy('initialize', {}));
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result.serverInfo).toEqual(SERVER_INFO);
  });

  it('still answers legacy ping and swallows legacy notifications', async () => {
    expect((await dispatch(legacy('ping'))).result).toBeTruthy();
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});

describe('per-request version declaration (2026-07-28)', () => {
  /**
   * The modern era has no handshake to echo into, so "not downgraded" means:
   * a request declaring 2026-07-28 is accepted and served with MODERN
   * semantics, rather than silently answered under a 2025 revision.
   */
  it('serves a request declaring 2026-07-28 without downgrading it', async () => {
    const res = await dispatch(modern('tools/list'));
    expect(res.error).toBeUndefined();
    expect(res.result.resultType).toBe('complete');
  });

  it('echoes 2026-07-28 back as the first supported version via server/discover', async () => {
    const res = await dispatch(modern('server/discover'));
    expect(res.result.supportedVersions).toContain(MODERN);
    expect(res.result.supportedVersions[0]).toBe(MODERN);
  });

  it('rejects an unknown declared version with UnsupportedProtocolVersionError', async () => {
    const res = await dispatch(modern('tools/list', {}, '1900-01-01'));
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION);
    expect(res.error.code).toBe(-32022);
    expect(res.error.data.requested).toBe('1900-01-01');
    expect(res.error.data.supported).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
  });

  it('rejects a future revision it does not implement rather than guessing', async () => {
    const res = await dispatch(modern('tools/list', {}, '2027-01-01'));
    expect(res.error.code).toBe(MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION);
  });
});

describe('server/discover (MUST be implemented)', () => {
  it('answers with supported versions, capabilities and identity', async () => {
    const res = await dispatch(modern('server/discover'));
    expect(res.result.supportedVersions).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result._meta[META_SERVER_INFO]).toEqual(SERVER_INFO);
    expect(typeof res.result.instructions).toBe('string');
  });

  it('carries the CacheableResult fields', async () => {
    const res = await dispatch(modern('server/discover'));
    expect(res.result.ttlMs).toBe(LIST_CACHE_TTL_MS);
    expect(res.result.cacheScope).toBe(LIST_CACHE_SCOPE);
  });

  /** A dual-era client probes with server/discover before it knows our era. */
  it('answers even when the request declares no version at all', async () => {
    const res = await dispatch(legacy('server/discover'));
    expect(res.result.supportedVersions).toContain(MODERN);
  });
});

describe('modern era removes initialize / ping', () => {
  it('reports method-not-found for initialize under 2026-07-28', async () => {
    const res = await dispatch(modern('initialize', { protocolVersion: MODERN }));
    expect(res.error.code).toBe(MCP_ERROR_METHOD_NOT_FOUND);
  });

  it('reports method-not-found for ping under 2026-07-28', async () => {
    const res = await dispatch(modern('ping'));
    expect(res.error.code).toBe(MCP_ERROR_METHOD_NOT_FOUND);
  });
});

describe('result envelope', () => {
  it('tags every result with resultType: complete', async () => {
    expect((await dispatch(modern('tools/list'))).result.resultType).toBe('complete');
    expect((await dispatch(legacy('tools/list'))).result.resultType).toBe('complete');
    expect((await dispatch(legacy('initialize', {}))).result.resultType).toBe('complete');
  });

  it('identifies the server in each result _meta', async () => {
    const res = await dispatch(modern('tools/list'));
    expect(res.result._meta[META_SERVER_INFO]).toEqual(SERVER_INFO);
  });

  it('gives tools/list the required cache hints in both eras', async () => {
    for (const msg of [modern('tools/list'), legacy('tools/list')]) {
      const res = await dispatch(msg);
      expect(res.result.ttlMs).toBe(LIST_CACHE_TTL_MS);
      expect(res.result.cacheScope).toBe(LIST_CACHE_SCOPE);
      expect(res.result.tools[0].name).toBe('t_read');
    }
  });

  it('keeps tools/call working (and scope-gated) in the modern era', async () => {
    const allowed = await dispatch(modern('tools/call', { name: 't_read', arguments: {} }));
    expect(allowed.result.isError).toBe(false);
    expect(allowed.result.content[0].text).toBe('read-ok');

    const denied = (await handleMcpRpc(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modern('tools/call', { name: 't_read', arguments: {} }) as any,
      { ...CTX, scopes: new Set<string>() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain('insufficient_scope');
  });
});

describe('readRequestProtocolVersion', () => {
  it('reads the reserved _meta key', () => {
    expect(readRequestProtocolVersion(modern('tools/list'))).toBe(MODERN);
  });

  it('returns undefined for a legacy request', () => {
    expect(readRequestProtocolVersion(legacy('tools/list'))).toBeUndefined();
    expect(readRequestProtocolVersion({ jsonrpc: '2.0', method: 'ping' })).toBeUndefined();
  });

  it('ignores a non-string version', () => {
    expect(
      readRequestProtocolVersion({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: { _meta: { [META_PROTOCOL_VERSION]: 20260728 } },
      }),
    ).toBeUndefined();
  });
});

describe('validateModernRequestHeaders', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;

  it('accepts a well-formed modern request', () => {
    const msg = modern('tools/call', { name: 't_read', arguments: {} });
    const reason = validateModernRequestHeaders(
      msg,
      headers({ 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 't_read' }),
    );
    expect(reason).toBeNull();
  });

  /**
   * Legacy clients send none of these headers. Validating them there would
   * reject clients that are behaving correctly for the version they declared.
   */
  it('skips validation entirely for legacy requests', () => {
    expect(validateModernRequestHeaders(legacy('tools/list'), headers({}))).toBeNull();
    expect(
      validateModernRequestHeaders(legacy('tools/list'), headers({ 'mcp-protocol-version': '2025-06-18' })),
    ).toBeNull();
  });

  it('rejects a missing MCP-Protocol-Version header', () => {
    const reason = validateModernRequestHeaders(modern('tools/list'), headers({}));
    expect(reason).toContain('MCP-Protocol-Version');
  });

  it('rejects a header/body version disagreement', () => {
    const reason = validateModernRequestHeaders(
      modern('tools/list'),
      headers({ 'mcp-protocol-version': '2025-06-18', 'mcp-method': 'tools/list' }),
    );
    expect(reason).toContain('does not match body value');
  });

  it('rejects a modern header with no version in the body _meta', () => {
    const reason = validateModernRequestHeaders(
      legacy('tools/list'),
      headers({ 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }),
    );
    expect(reason).toContain(META_PROTOCOL_VERSION);
  });

  it('rejects a missing or mismatched Mcp-Method', () => {
    expect(
      validateModernRequestHeaders(modern('tools/list'), headers({ 'mcp-protocol-version': MODERN })),
    ).toContain('Mcp-Method');

    expect(
      validateModernRequestHeaders(
        modern('tools/list'),
        headers({ 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call' }),
      ),
    ).toContain('Mcp-Method');
  });

  /**
   * The confused-deputy case: an intermediary routes on `Mcp-Name` while the
   * server executes `params.name`. If those can disagree, policy applied at the
   * edge is applied to the wrong tool.
   */
  it('rejects an Mcp-Name that disagrees with params.name', () => {
    const reason = validateModernRequestHeaders(
      modern('tools/call', { name: 't_read' }),
      headers({
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'something_else',
      }),
    );
    expect(reason).toContain('Mcp-Name');
  });

  it('rejects a missing Mcp-Name on tools/call', () => {
    const reason = validateModernRequestHeaders(
      modern('tools/call', { name: 't_read' }),
      headers({ 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call' }),
    );
    expect(reason).toBe('Missing required header: Mcp-Name');
  });

  it('decodes the =?base64?…?= sentinel before comparing Mcp-Name', () => {
    const name = 'tool_世界';
    const encoded = `=?base64?${Buffer.from(name, 'utf8').toString('base64')}?=`;
    const reason = validateModernRequestHeaders(
      modern('tools/call', { name }),
      headers({ 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': encoded }),
    );
    expect(reason).toBeNull();
  });

  it('does not require Mcp-Name for methods that have no name to mirror', () => {
    const reason = validateModernRequestHeaders(
      modern('tools/list'),
      headers({ 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }),
    );
    expect(reason).toBeNull();
  });
});

describe('httpStatusForModernResponse', () => {
  /**
   * A dual-era client decides whether we are modern by reading the BODY of a
   * 4xx. Answering 200 to a modern protocol error makes us look legacy and
   * sends the client down the `initialize` fallback.
   */
  it('maps version + header errors to 400', () => {
    expect(
      httpStatusForModernResponse({ error: { code: MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION } }),
    ).toBe(400);
    expect(httpStatusForModernResponse({ error: { code: MCP_ERROR_HEADER_MISMATCH } })).toBe(400);
  });

  it('maps an unknown method to 404', () => {
    expect(httpStatusForModernResponse({ error: { code: MCP_ERROR_METHOD_NOT_FOUND } })).toBe(404);
  });

  it('leaves successful results and in-band tool errors at 200', () => {
    expect(httpStatusForModernResponse({ result: { resultType: 'complete' } })).toBe(200);
    expect(httpStatusForModernResponse({ error: { code: -32602 } })).toBe(200);
  });
});
