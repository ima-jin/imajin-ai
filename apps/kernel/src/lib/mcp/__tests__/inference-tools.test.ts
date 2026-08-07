/**
 * Scope gating for the inference MCP tools (#1298).
 *
 * `inference_capture` / `inference_status` used to ride `media:write` /
 * `media:read`, so any agent holding a media grant could drive the intention
 * inference pipeline and have a supply attestation signed on the owner's
 * behalf. They now hold `inference:write` / `inference:read`.
 *
 * These tests run the REAL tool descriptors through the REAL gate in server.ts —
 * `scope-gate.test.ts` covers the gate against stand-in tools, which cannot
 * catch a `requiredScope` regression in `tools/inference.ts` itself. The
 * handlers are never reached: every assertion here is about the gate, so the
 * DB-backed pipeline modules are stubbed rather than exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// tools/inference.ts pulls in the DB client and the whole inference pipeline at
// module load; `createDb` throws without DATABASE_URL. Stub them so the module
// imports cleanly.

vi.mock('@/src/db', () => ({
  db: {},
  inferenceSessions: {},
  inferenceAttestations: {},
}));

vi.mock('@/src/lib/inference/context', () => ({ gatherContext: vi.fn() }));
vi.mock('@/src/lib/inference/policy', () => ({ infer: vi.fn() }));
vi.mock('@/src/lib/inference/consent', () => ({ resolveConsentGate: vi.fn() }));
vi.mock('@/src/lib/inference/resolve', () => ({ resolveIntent: vi.fn() }));
// A truthy stub: `inference_capture` rejects an unknown vocabulary before it
// looks at text/assetId, and the argument check is what proves the scope gate
// let the call reach the handler.
vi.mock('@/src/lib/inference/vocabulary', () => ({
  getVocabulary: vi.fn(() => ({ name: 'imajin' })),
  listVocabularyNames: vi.fn(() => ['imajin']),
}));
vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: vi.fn() }));

// Swap the registry for the real inference tools only, so the gate in server.ts
// runs against them without loading every other (DB-backed) tool module.
vi.mock('../tools', async () => {
  const { inferenceTools } = await import('../tools/inference');
  const byName = new Map(inferenceTools.map((t) => [t.name, t]));
  return { ALL_TOOLS: inferenceTools, toolByName: (n: string) => byName.get(n) };
});

// Gate 2 (channel_links) is DB-backed; default it to "no grant" so a denial
// reads `insufficient_scope` rather than the #1647 stale-token variant.
const mockResolveGrant = vi.hoisted(() => vi.fn<(did: string, scope: string) => Promise<boolean>>());
vi.mock('../mcp-grant', () => ({
  resolveActiveMcpGrant: (...args: [string, string]) => mockResolveGrant(...args),
}));

import { handleMcpRpc } from '../server';
import { inferenceTools } from '../tools/inference';

beforeEach(() => {
  mockResolveGrant.mockReset();
  mockResolveGrant.mockResolvedValue(false);
});

function call(name: string, scopes: string[]) {
  const ctx = { did: 'did:imajin:user', appDid: 'did:imajin:app', scopes: new Set(scopes) };
  return handleMcpRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
    ctx,
  ) as Promise<any>;
}

function tool(name: string) {
  const t = inferenceTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

// ─── Descriptors ───────────────────────────────────────────────────────────

describe('inference tool registration', () => {
  it('exports the capture and status tools', () => {
    expect(inferenceTools.map((t) => t.name)).toEqual(['inference_capture', 'inference_status']);
  });

  it('gates capture on inference:write and status on inference:read', () => {
    expect(tool('inference_capture').requiredScope).toBe('inference:write');
    expect(tool('inference_status').requiredScope).toBe('inference:read');
  });

  it('gates neither tool on a media scope', () => {
    for (const t of inferenceTools) {
      expect(t.requiredScope).not.toMatch(/^media:/);
    }
  });
});

// ─── The gate ──────────────────────────────────────────────────────────────

describe('inference_capture requires its own write grant', () => {
  /** The whole point of #1298: media:write is no longer a licence to infer. */
  it('denies a full media token that lacks inference:write', async () => {
    const res = await call('inference_capture', ['media:read', 'media:write', 'media:share']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('inference:write');
  });

  it('denies a read-only inference token', async () => {
    const res = await call('inference_capture', ['inference:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('inference:write');
  });

  /**
   * Passing the gate reaches the handler, which fails on its own arguments
   * ("Provide either text or assetId"). That failure IS the evidence the scope
   * check let the call through — it is raised after the gate, not by it.
   */
  it('lets an inference:write token past the gate and into the handler', async () => {
    const res = await call('inference_capture', ['inference:write']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).not.toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('Provide either text or assetId');
  });
});

describe('inference_status requires its own read grant', () => {
  it('denies a media:read token that lacks inference:read', async () => {
    const res = await call('inference_status', ['media:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('inference:read');
  });

  it('denies a write-only inference token', async () => {
    const res = await call('inference_status', ['inference:write']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('inference:read');
  });

  it('lets an inference:read token past the gate and into the handler', async () => {
    const res = await call('inference_status', ['inference:read']);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).not.toContain('insufficient_scope');
    expect(res.result.content[0].text).toContain('sessionId is required');
  });
});
