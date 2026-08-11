import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── projectConsentedScopes (#1804) — unit tests ────────────────────────────
//
// Exercises the generic consent → scope-manifest publish primitive with
// `publishConnectorScopeManifest` mocked out (its own orchestration is tested
// in scope-manifest-core.test.ts). This file proves:
//   - scopes are grouped by their OWNING connector (vocabulary-derived);
//   - platform / unknown scopes are dropped (no owning connector manifest);
//   - the manifest's currently-active scopes are always preserved (union,
//     never clobbered);
//   - a scope the connector-wide manifest has EVER revoked is never re-added
//     (the narrowing signal), and is reported back as `skippedNarrowed`;
//   - a publish failure for one connector does not prevent another
//     connector's publish in the same consent event.

type Row = { channel: string; did: string; appDid: string; status: string; scopes: string[] };

const h = vi.hoisted(() => {
  const rows: Row[] = [];
  const F = {
    channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
  };

  type Pred = { op: string; col?: string; val?: unknown; preds?: Pred[] };
  const match = (row: Row, pred: Pred): boolean => {
    switch (pred.op) {
      case 'eq':  return (row as Record<string, unknown>)[pred.col as string] === pred.val;
      case 'and': return (pred.preds ?? []).every((p) => match(row, p));
      default:    return true;
    }
  };

  const db = {
    select: (_proj?: unknown) => ({
      from: (_table: unknown) => ({
        where: (pred: Pred) =>
          Promise.resolve(rows.filter((r) => match(r, pred)).map((r) => ({ scopes: r.scopes }))),
      }),
    }),
  };

  return { rows, F, db };
});

vi.mock('@/src/db', () => ({ db: h.db, channelLinks: h.F.channelLinks }));
vi.mock('drizzle-orm', () => ({
  eq:  (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...preds: unknown[])        => ({ op: 'and', preds }),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn(async () => 'asset_xxx') }));
vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({ publishConnectorScopeManifest: mockPublish }));

import { projectConsentedScopes } from '../consent-scope-projection';

const OWNER = 'did:imajin:owner';
const CLIENT = 'did:imajin:client-a';
const MCP_DID = 'did:imajin:mcp-connector';
const GITHUB_DID = 'did:imajin:github-connector';

function activeRow(scopes: string[], appDid: string, channel = 'mcp'): Row {
  return { channel, did: OWNER, appDid, status: 'active', scopes };
}
function revokedRow(scopes: string[], appDid: string, channel = 'mcp'): Row {
  return { channel, did: OWNER, appDid, status: 'revoked', scopes };
}

beforeEach(() => {
  h.rows.splice(0, h.rows.length);
  mockPublish.mockClear();
  mockPublish.mockResolvedValue('asset_xxx');
});

describe('projectConsentedScopes — connector grouping', () => {
  it('publishes one manifest per owning connector', async () => {
    const outcomes = await projectConsentedScopes({
      ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read', 'github:read'],
    });

    expect(mockPublish).toHaveBeenCalledTimes(2);
    const connectors = outcomes.map((o) => o.connector).sort();
    expect(connectors).toEqual(['github', 'mcp']);

    const mcpCall = mockPublish.mock.calls.find((c) => c[0].connectorDid === MCP_DID)?.[0];
    expect(mcpCall).toMatchObject({ connectorDid: MCP_DID, channel: 'mcp', filename: 'mcp-scope-manifest.md', appDid: CLIENT });
    expect(mcpCall.scopes).toEqual(['media:read']);

    const githubCall = mockPublish.mock.calls.find((c) => c[0].connectorDid === GITHUB_DID)?.[0];
    expect(githubCall).toMatchObject({ connectorDid: GITHUB_DID, channel: 'github', filename: 'github-scope-manifest.md', appDid: CLIENT });
  });

  it('drops platform scopes (no owning connector) and unknown scope strings', async () => {
    const outcomes = await projectConsentedScopes({
      ownerDid: OWNER, appDid: CLIENT, scopes: ['profile:read', 'totally:not-a-real-scope', 'media:read'],
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].connector).toBe('mcp');
    expect(outcomes[0].added).toEqual(['media:read']);
  });

  it('is a no-op when every scope is unknown/platform', async () => {
    const outcomes = await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['profile:read'] });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });
});

describe('projectConsentedScopes — additive merge (never clobbers the card)', () => {
  it('unions newly granted scopes with the existing connector-wide manifest', async () => {
    h.rows.push(activeRow(['connections:read'], MCP_DID));

    const outcomes = await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    const call = mockPublish.mock.calls[0][0];
    expect(new Set(call.scopes)).toEqual(new Set(['connections:read', 'media:read']));
    expect(outcomes[0].added).toEqual(['media:read']);
  });

  it('is idempotent — re-consenting an already-active scope adds nothing new', async () => {
    h.rows.push(activeRow(['media:read'], MCP_DID));

    const outcomes = await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    const call = mockPublish.mock.calls[0][0];
    expect(call.scopes).toEqual(['media:read']);
    expect(outcomes[0].added).toEqual([]);
  });

  it('never drops an existing active scope not present in the new consent event', async () => {
    h.rows.push(activeRow(['connections:read', 'media:read'], MCP_DID));

    // This consent event only re-grants media:read (e.g. a narrower client).
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    const call = mockPublish.mock.calls[0][0];
    expect(call.scopes).toContain('connections:read');
    expect(call.scopes).toContain('media:read');
  });
});

describe('projectConsentedScopes — never re-widens a narrowed scope', () => {
  it('skips a scope the connector-wide manifest has previously revoked', async () => {
    h.rows.push(revokedRow(['media:write'], MCP_DID));

    const outcomes = await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:write'] });

    const call = mockPublish.mock.calls[0][0];
    expect(call.scopes).not.toContain('media:write');
    expect(outcomes[0].added).toEqual([]);
    expect(outcomes[0].skippedNarrowed).toEqual(['media:write']);
  });

  it('still adds sibling scopes granted alongside a narrowed one', async () => {
    h.rows.push(revokedRow(['media:write'], MCP_DID));

    const outcomes = await projectConsentedScopes({
      ownerDid: OWNER, appDid: CLIENT, scopes: ['media:write', 'media:read'],
    });

    const call = mockPublish.mock.calls[0][0];
    expect(call.scopes).toEqual(['media:read']);
    expect(outcomes[0].added).toEqual(['media:read']);
    expect(outcomes[0].skippedNarrowed).toEqual(['media:write']);
  });

  it('does not skip a scope that was never previously touched (no history at all)', async () => {
    const outcomes = await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    expect(outcomes[0].added).toEqual(['media:read']);
    expect(outcomes[0].skippedNarrowed).toEqual([]);
  });
});

describe('projectConsentedScopes — per-connector failure isolation', () => {
  it("one connector's publish failure does not prevent another connector's publish", async () => {
    mockPublish.mockImplementation(async (opts: { connectorDid: string }) => {
      if (opts.connectorDid === MCP_DID) throw new Error('boom');
      return 'asset_github';
    });

    const outcomes = await projectConsentedScopes({
      ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read', 'github:read'],
    });

    expect(mockPublish).toHaveBeenCalledTimes(2);
    const mcpOutcome = outcomes.find((o) => o.connector === 'mcp');
    const githubOutcome = outcomes.find((o) => o.connector === 'github');
    expect(mcpOutcome).toMatchObject({ assetId: null, error: expect.stringContaining('boom') });
    expect(githubOutcome).toMatchObject({ assetId: 'asset_github' });
  });
});
