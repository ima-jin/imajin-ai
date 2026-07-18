import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── GitHub scope-manifest publisher unit tests (#1352) ───────────────────────
//
// Tests three layers of the new publish path:
//
//   buildManifestContent  — pure YAML builder; no mocks, exercised directly.
//   findGitHubManifestAsset / readActiveGitHubScopes — DB-layer functions;
//     in-memory drizzle fake with per-row predicate matching.
//   publishGitHubScopeManifest — orchestration; createAsset + updateAssetContent
//     are mocked so we can assert call shapes, not their internals.
//
// Only the I/O edges are stubbed; the manifest builder and the GITHUB_CONNECTOR_DID
// constant run as real code throughout.

// ── Hoisted state + mocks ─────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { assetRows: Row[]; channelRows: Row[] } = {
    assetRows: [],
    channelRows: [],
  };

  // Field-id markers. Their values are the column names the predicate evaluator
  // reads off a row — keeps the mock simple enough to follow.
  const F = {
    assets: {
      id: 'id',
      ownerDid: 'ownerDid',
      status: 'status',
      metadata: 'metadata',
    },
    channelLinks: {
      channel: 'channel',
      did: 'did',
      appDid: 'appDid',
      status: 'status',
      scopes: 'scopes',
    },
  };

  type Pred = { op: string; col?: string; val?: unknown; preds?: Pred[] };

  const match = (row: Row, pred: Pred | undefined): boolean => {
    if (!pred) return true;
    switch (pred.op) {
      case 'eq':
        return row[pred.col as string] === pred.val;
      case 'and':
        return (pred.preds ?? []).every((p) => match(row, p));
      // sql`` JSONB predicates arrive as { op: 'sql' } and are treated as
      // always-true so callers control matches via state setup, not JSONB eval.
      default:
        return true;
    }
  };

  const resolve = (table: unknown, pred: Pred | undefined): Row[] => {
    if (table === F.assets) return state.assetRows.filter((r) => match(r, pred));
    if (table === F.channelLinks) return state.channelRows.filter((r) => match(r, pred));
    return [];
  };

  const updateCalls: Array<{ table: unknown; set: Row; pred: Pred }> = [];

  const db = {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: (pred: Pred) => {
          const run = () => Promise.resolve(resolve(table, pred));
          return { limit: (_n: number) => run(), then: (f: any, r: any) => run().then(f, r) };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (v: Row) => ({
        where: (pred: Pred) => {
          updateCalls.push({ table, set: v, pred });
          if (table === F.assets) {
            for (const r of state.assetRows) if (match(r, pred)) Object.assign(r, v);
          }
          return Promise.resolve();
        },
      }),
    }),
  };

  return { state, F, db, updateCalls };
});

vi.mock('@/src/db', () => ({
  db: h.db,
  assets: h.F.assets,
  channelLinks: h.F.channelLinks,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...preds: unknown[]) => ({ op: 'and', preds }),
  // sql`` tagged template → always-true sentinel so JSONB conditions are
  // exercised structurally but row filtering is controlled by state setup.
  sql: Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => ({ op: 'sql' }),
    {},
  ),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

const { mockCreateAsset, mockUpdateAssetContent } = vi.hoisted(() => ({
  mockCreateAsset: vi.fn(),
  mockUpdateAssetContent: vi.fn(),
}));

vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: mockCreateAsset }));
vi.mock('@/src/lib/media/update-asset', () => ({ updateAssetContent: mockUpdateAssetContent }));

// Break the transitive dependency chain: connector.ts imports @/src/lib/vault
// which the vitest resolver cannot find outside a full kernel env. We only need
// the DID constant from connector.ts, so mock the whole module.
vi.mock('../connector', () => ({ GITHUB_CONNECTOR_DID: 'did:imajin:github-connector' }));

// Imports after all vi.mock() calls (vitest hoisting requirement).
import {
  buildManifestContent,
  findGitHubManifestAsset,
  readActiveGitHubScopes,
  publishGitHubScopeManifest,
  VALID_GITHUB_SCOPES,
  GITHUB_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { GITHUB_CONNECTOR_DID } from '../connector';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER = 'did:imajin:jin';
const ASSET_ID = 'asset_github_manifest_001';

function manifestAssetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSET_ID,
    ownerDid: OWNER,
    status: 'active',
    metadata: { kind: 'scope-manifest', connector: GITHUB_CONNECTOR_DID, channel: 'github' },
    storagePath: '/mnt/media/owner/assets/asset_github_manifest_001.md',
    ...overrides,
  };
}

function channelRow(scope: string, status = 'active'): Row {
  return {
    channel: 'github',
    did: OWNER,
    appDid: GITHUB_CONNECTOR_DID,
    scopes: [scope],
    status,
  };
}

beforeEach(() => {
  h.state.assetRows = [];
  h.state.channelRows = [];
  h.updateCalls.length = 0;
  mockCreateAsset.mockReset();
  mockUpdateAssetContent.mockReset();
  mockUpdateAssetContent.mockResolvedValue({ ok: true, asset: manifestAssetRow() });
});

// ── buildManifestContent ──────────────────────────────────────────────────────

describe('buildManifestContent', () => {
  it('produces required YAML header fields', () => {
    const content = buildManifestContent(['github:read']);
    expect(content).toContain('kind: scope-manifest');
    expect(content).toContain(`connector: "${GITHUB_CONNECTOR_DID}"`);
    expect(content).toContain('channel: github');
  });

  it('includes only the requested scope data rows', () => {
    const content = buildManifestContent(['github:read']);
    expect(content).toContain('"github:read":');
    expect(content).not.toContain('"github:write":');
    expect(content).not.toContain('"github:org":');
    expect(content).not.toContain('"github:actions":');
  });

  it('includes both scopes when both are requested', () => {
    const content = buildManifestContent(['github:read', 'github:write']);
    expect(content).toContain('"github:read":');
    expect(content).toContain('"github:write":');
  });

  it('emits a release: block for each requested scope', () => {
    const content = buildManifestContent(['github:read', 'github:write']);
    expect(content).toContain('release:');
    // github:read is silent — discloses_others: false, sensitive: false, no release override.
    const readIdx = content.indexOf('"github:read":\n    discloses_others:');
    expect(readIdx).toBeGreaterThan(-1);
    // github:write is on-consent — must carry explicit release + viewer.
    expect(content).toContain('release: on-consent');
    expect(content).toContain(`viewer: "${GITHUB_CONNECTOR_DID}"`);
  });

  it('silently drops unknown scope names', () => {
    const content = buildManifestContent(['github:read', 'github:nonexistent']);
    expect(content).toContain('"github:read":');
    expect(content).not.toContain('"github:nonexistent":');
  });

  it('produces a valid YAML frontmatter block (delimited by ---)', () => {
    const content = buildManifestContent(['github:read']);
    const lines = content.split('\n');
    expect(lines[0]).toBe('---');
    // Second --- closes the frontmatter block.
    const closingIdx = lines.indexOf('---', 1);
    expect(closingIdx).toBeGreaterThan(1);
  });

  it('emits an empty (but valid) manifest when no scopes are requested', () => {
    const content = buildManifestContent([]);
    expect(content).toContain('kind: scope-manifest');
    // No scope data rows or release entries beyond the headers.
    expect(content).not.toContain('"github:read":');
    expect(content).not.toContain('"github:write":');
  });

  it('VALID_GITHUB_SCOPES lists all four known scopes', () => {
    expect(new Set(VALID_GITHUB_SCOPES)).toEqual(
      new Set(['github:read', 'github:write', 'github:org', 'github:actions']),
    );
  });

  it('GITHUB_SCOPE_DESCRIPTORS carries github:read as silent (no release override)', () => {
    const r = GITHUB_SCOPE_DESCRIPTORS['github:read'].release;
    expect(r.discloses_others).toBe(false);
    expect(r.sensitive).toBe(false);
    expect(r.release).toBeUndefined(); // silent — derived from 2×2, no tightening
  });

  it('GITHUB_SCOPE_DESCRIPTORS marks github:write as on-consent', () => {
    const r = GITHUB_SCOPE_DESCRIPTORS['github:write'].release;
    expect(r.release).toBe('on-consent');
    expect(r.viewer).toBe(GITHUB_CONNECTOR_DID);
  });

  it('GITHUB_SCOPE_DESCRIPTORS marks github:actions with discloses_others: true + sensitive: true', () => {
    const r = GITHUB_SCOPE_DESCRIPTORS['github:actions'].release;
    expect(r.discloses_others).toBe(true);
    expect(r.sensitive).toBe(true);
    // No release override; derived tier = never.
    expect(r.release).toBeUndefined();
  });
});

// ── findGitHubManifestAsset ───────────────────────────────────────────────────

describe('findGitHubManifestAsset', () => {
  it('returns null when no asset row exists for the owner', async () => {
    const result = await findGitHubManifestAsset(OWNER);
    expect(result).toBeNull();
  });

  it('returns the matching asset when one exists', async () => {
    const row = manifestAssetRow();
    h.state.assetRows = [row];
    const result = await findGitHubManifestAsset(OWNER);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(ASSET_ID);
  });

  it('does not return assets belonging to a different owner', async () => {
    h.state.assetRows = [manifestAssetRow({ ownerDid: 'did:imajin:other' })];
    const result = await findGitHubManifestAsset(OWNER);
    // The eq(ownerDid) predicate filters the row out.
    expect(result).toBeNull();
  });

  it('does not return deleted assets', async () => {
    h.state.assetRows = [manifestAssetRow({ status: 'deleted' })];
    const result = await findGitHubManifestAsset(OWNER);
    expect(result).toBeNull();
  });
});

// ── readActiveGitHubScopes ────────────────────────────────────────────────────

describe('readActiveGitHubScopes', () => {
  it('returns an empty array when there are no channel_links rows', async () => {
    const scopes = await readActiveGitHubScopes(OWNER);
    expect(scopes).toEqual([]);
  });

  it('returns the scope string from each active row', async () => {
    h.state.channelRows = [channelRow('github:read'), channelRow('github:write')];
    const scopes = await readActiveGitHubScopes(OWNER);
    expect(scopes.sort()).toEqual(['github:read', 'github:write']);
  });

  it('excludes revoked rows', async () => {
    h.state.channelRows = [
      channelRow('github:read'),
      channelRow('github:write', 'revoked'),
    ];
    const scopes = await readActiveGitHubScopes(OWNER);
    expect(scopes).toEqual(['github:read']);
  });

  it('excludes rows for a different owner', async () => {
    h.state.channelRows = [{ ...channelRow('github:read'), did: 'did:imajin:other' }];
    const scopes = await readActiveGitHubScopes(OWNER);
    expect(scopes).toEqual([]);
  });
});

// ── publishGitHubScopeManifest ────────────────────────────────────────────────

describe('publishGitHubScopeManifest — new manifest (no existing asset)', () => {
  beforeEach(() => {
    // No existing manifest asset.
    h.state.assetRows = [];
    mockCreateAsset.mockResolvedValue({
      asset: manifestAssetRow(),
      deduplicated: false,
    });
  });

  it('calls createAsset with the correct shape on first publish', async () => {
    await publishGitHubScopeManifest(OWNER, ['github:read']);

    expect(mockCreateAsset).toHaveBeenCalledOnce();
    const call = mockCreateAsset.mock.calls[0][0] as Record<string, unknown>;
    expect(call.ownerDid).toBe(OWNER);
    expect(call.filename).toBe('github-scope-manifest.md');
    expect(call.mimeType).toBe('text/markdown');
    expect(call.access).toBe('private');
    expect(call.dedup).toBe(false);
    expect(call.classify).toBe(false);
    expect(call.buffer).toBeInstanceOf(Buffer);
  });

  it('stamps the asset metadata with kind/connector/channel before firing document.changed', async () => {
    await publishGitHubScopeManifest(OWNER, ['github:read']);

    // The metadata stamp must occur before updateAssetContent is called.
    const metaUpdate = h.updateCalls.find(
      (c) => c.table === h.F.assets && typeof c.set.metadata === 'object',
    );
    expect(metaUpdate).toBeDefined();
    expect(metaUpdate!.set.metadata).toMatchObject({
      kind: 'scope-manifest',
      connector: GITHUB_CONNECTOR_DID,
      channel: 'github',
    });
    // updateAssetContent must be called after createAsset (so the metadata
    // stamp happens in between). Compare invocation order numbers.
    const createOrder = mockCreateAsset.mock.invocationCallOrder[0];
    const updateOrder = mockUpdateAssetContent.mock.invocationCallOrder[0];
    expect(updateOrder).toBeGreaterThan(createOrder);
  });

  it('calls updateAssetContent with the owner DID and manifest content', async () => {
    await publishGitHubScopeManifest(OWNER, ['github:read']);

    expect(mockUpdateAssetContent).toHaveBeenCalledOnce();
    const call = mockUpdateAssetContent.mock.calls[0][0] as Record<string, unknown>;
    expect(call.assetId).toBe(ASSET_ID);
    expect(call.requesterDid).toBe(OWNER);
    expect(typeof call.content).toBe('string');
    expect(call.content as string).toContain('kind: scope-manifest');
  });

  it('returns the asset id of the newly-created manifest', async () => {
    const assetId = await publishGitHubScopeManifest(OWNER, ['github:read']);
    expect(assetId).toBe(ASSET_ID);
  });

  it('throws when updateAssetContent fails', async () => {
    mockUpdateAssetContent.mockResolvedValue({ ok: false, code: 'forbidden', message: 'Access denied' });
    await expect(publishGitHubScopeManifest(OWNER, ['github:read'])).rejects.toThrow(
      /scope-manifest update failed.*forbidden/,
    );
  });
});

describe('publishGitHubScopeManifest — existing manifest (update path)', () => {
  beforeEach(() => {
    // Pre-load an existing manifest row.
    h.state.assetRows = [manifestAssetRow()];
  });

  it('skips createAsset when an existing manifest asset is found', async () => {
    await publishGitHubScopeManifest(OWNER, ['github:read', 'github:write']);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('calls updateAssetContent with the updated scope list', async () => {
    await publishGitHubScopeManifest(OWNER, ['github:read', 'github:write']);

    expect(mockUpdateAssetContent).toHaveBeenCalledOnce();
    const { content } = mockUpdateAssetContent.mock.calls[0][0] as { content: string };
    expect(content).toContain('"github:read":');
    expect(content).toContain('"github:write":');
  });

  it('does not stamp metadata when updating an existing asset', async () => {
    await publishGitHubScopeManifest(OWNER, ['github:read']);
    // No db.update(assets) calls expected when the asset already exists.
    const metaUpdate = h.updateCalls.find(
      (c) => c.table === h.F.assets && typeof c.set.metadata === 'object',
    );
    expect(metaUpdate).toBeUndefined();
  });

  it('reuses the same asset id on repeated calls (idempotent)', async () => {
    const id1 = await publishGitHubScopeManifest(OWNER, ['github:read']);
    const id2 = await publishGitHubScopeManifest(OWNER, ['github:read', 'github:write']);
    expect(id1).toBe(ASSET_ID);
    expect(id2).toBe(ASSET_ID);
    // createAsset never called on either invocation since the row exists.
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('an empty scopes list revokes all by producing a manifest with no scope rows', async () => {
    await publishGitHubScopeManifest(OWNER, []);
    const { content } = mockUpdateAssetContent.mock.calls[0][0] as { content: string };
    expect(content).not.toContain('"github:read":');
    expect(content).not.toContain('"github:write":');
    // Header fields still present.
    expect(content).toContain('kind: scope-manifest');
  });
});
