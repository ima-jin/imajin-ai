import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── scope-manifest-core unit tests ──────────────────────────────────────────
//
// Tests the shared connector scope-manifest logic: YAML builder, asset lookup,
// active-scopes reader, consent-grant sync, and publish orchestration. The
// connector wrappers (GitHub, Discord) are tested separately for their specific
// descriptor values; the logic itself is tested here once.

type Row = Record<string, unknown>;

const CONNECTOR_DID = 'did:imajin:test-connector';
const CHANNEL = 'testchannel';

const h = vi.hoisted(() => {
  const state: { assetRows: Row[]; channelRows: Row[]; consentRows: Row[] } = {
    assetRows: [], channelRows: [], consentRows: [],
  };

  const F = {
    assets: { id: 'id', ownerDid: 'ownerDid', status: 'status', metadata: 'metadata' },
    channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
    consentGrants: {
      id: 'id', subject: 'subject', grantedTo: 'grantedTo', purpose: 'purpose',
      allowedFields: 'allowedFields', mode: 'mode', status: 'status',
      consentRef: 'consentRef', updatedAt: 'updatedAt',
    },
  };

  type Pred = { op: string; col?: string; val?: unknown; preds?: Pred[] };
  const match = (row: Row, pred: Pred | undefined): boolean => {
    if (!pred) return true;
    switch (pred.op) {
      case 'eq': return row[pred.col as string] === pred.val;
      case 'and': return (pred.preds ?? []).every((p) => match(row, p));
      case 'like': {
        const prefix = String(pred.val).replace(/%$/, '');
        return typeof row[pred.col as string] === 'string' && (row[pred.col as string] as string).startsWith(prefix);
      }
      default: return true;
    }
  };

  const resolve = (table: unknown, pred: Pred | undefined): Row[] => {
    if (table === F.assets) return state.assetRows.filter((r) => match(r, pred));
    if (table === F.channelLinks) return state.channelRows.filter((r) => match(r, pred));
    if (table === F.consentGrants) return state.consentRows.filter((r) => match(r, pred));
    return [];
  };

  const updateCalls: Array<{ table: unknown; set: Row; pred: Pred }> = [];
  const insertCalls: Array<{ table: unknown; values: Row }> = [];

  const db = {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: (pred: Pred) => {
          const run = () => Promise.resolve(resolve(table, pred));
          return { limit: (_n: number) => run(), then: (f: any, r: any) => run().then(f, r) };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => {
        insertCalls.push({ table, values: v });
        if (table === F.consentGrants) state.consentRows.push({ ...v });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (v: Row) => ({
        where: (pred: Pred) => {
          updateCalls.push({ table, set: v, pred });
          if (table === F.assets) for (const r of state.assetRows) if (match(r, pred)) Object.assign(r, v);
          if (table === F.consentGrants) for (const r of state.consentRows) if (match(r, pred)) Object.assign(r, v);
          return Promise.resolve();
        },
      }),
    }),
  };

  return { state, F, db, updateCalls, insertCalls };
});

vi.mock('@/src/db', () => ({
  db: h.db, assets: h.F.assets, channelLinks: h.F.channelLinks, consentGrants: h.F.consentGrants,
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...preds: unknown[]) => ({ op: 'and', preds }),
  like: (col: unknown, val: unknown) => ({ op: 'like', col, val }),
  sql: Object.assign((_s: TemplateStringsArray, ..._v: unknown[]) => ({ op: 'sql' }), {}),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (p: string) => `${p}_test` }));
const { mockCreate, mockUpdate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
}));
vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: mockCreate }));
vi.mock('@/src/lib/media/update-asset', () => ({ updateAssetContent: mockUpdate }));

import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  connectorConsentRef,
  type ConnectorScopeDescriptor,
} from '../scope-manifest-core';

const OWNER = 'did:imajin:owner';
const ASSET_ID = 'asset_core_test';

const DESCRIPTORS: Record<string, ConnectorScopeDescriptor> = {
  'test:read':  { verb: 'read',  surface: 'items', label: 'Read items',  release: { discloses_others: false, sensitive: false } },
  'test:write': { verb: 'write', surface: 'items', label: 'Write items', release: { discloses_others: false, sensitive: false, release: 'on-consent', viewer: CONNECTOR_DID } },
};

function assetRow(overrides: Partial<Row> = {}): Row {
  return { id: ASSET_ID, ownerDid: OWNER, status: 'active', metadata: { kind: 'scope-manifest', connector: CONNECTOR_DID }, ...overrides };
}

function consentRow(scope: string, status = 'active'): Row {
  return { id: `cg_${scope}`, subject: OWNER, grantedTo: CONNECTOR_DID, purpose: 'document.projection', allowedFields: [scope], status, consentRef: `${ASSET_ID}:${scope}` };
}

beforeEach(() => {
  h.state.assetRows = [];
  h.state.channelRows = [];
  h.state.consentRows = [];
  h.updateCalls.length = 0;
  h.insertCalls.length = 0;
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue({ ok: true, asset: assetRow() });
});

// ── buildConnectorManifestContent ─────────────────────────────────────────────

describe('buildConnectorManifestContent', () => {
  it('includes connector DID, channel, and kind header', () => {
    const c = buildConnectorManifestContent(CONNECTOR_DID, CHANNEL, DESCRIPTORS, ['test:read']);
    expect(c).toContain(`connector: "${CONNECTOR_DID}"`);
    expect(c).toContain(`channel: ${CHANNEL}`);
    expect(c).toContain('kind: scope-manifest');
  });

  it('only includes requested scopes', () => {
    const c = buildConnectorManifestContent(CONNECTOR_DID, CHANNEL, DESCRIPTORS, ['test:read']);
    expect(c).toContain('"test:read":');
    expect(c).not.toContain('"test:write":');
  });

  it('drops unknown scope names', () => {
    const c = buildConnectorManifestContent(CONNECTOR_DID, CHANNEL, DESCRIPTORS, ['test:read', 'test:unknown']);
    expect(c).not.toContain('"test:unknown":');
  });

  it('emits on-consent release with viewer', () => {
    const c = buildConnectorManifestContent(CONNECTOR_DID, CHANNEL, DESCRIPTORS, ['test:write']);
    expect(c).toContain('release: on-consent');
    expect(c).toContain(`viewer: "${CONNECTOR_DID}"`);
  });

  it('produces valid YAML frontmatter delimiters', () => {
    const lines = buildConnectorManifestContent(CONNECTOR_DID, CHANNEL, DESCRIPTORS, ['test:read']).split('\n');
    expect(lines[0]).toBe('---');
    expect(lines.indexOf('---', 1)).toBeGreaterThan(1);
  });
});

// ── findConnectorManifestAsset ────────────────────────────────────────────────

describe('findConnectorManifestAsset', () => {
  it('returns null when no asset exists', async () => {
    expect(await findConnectorManifestAsset(OWNER, CONNECTOR_DID)).toBeNull();
  });

  it('returns the matching asset', async () => {
    h.state.assetRows = [assetRow()];
    expect((await findConnectorManifestAsset(OWNER, CONNECTOR_DID))?.id).toBe(ASSET_ID);
  });

  it('does not return assets for a different owner', async () => {
    h.state.assetRows = [assetRow({ ownerDid: 'other' })];
    expect(await findConnectorManifestAsset(OWNER, CONNECTOR_DID)).toBeNull();
  });

  it('does not return deleted assets', async () => {
    h.state.assetRows = [assetRow({ status: 'deleted' })];
    expect(await findConnectorManifestAsset(OWNER, CONNECTOR_DID)).toBeNull();
  });
});

// ── readActiveConnectorScopes ─────────────────────────────────────────────────

describe('readActiveConnectorScopes', () => {
  it('returns empty when no rows', async () => {
    expect(await readActiveConnectorScopes(OWNER, CHANNEL, CONNECTOR_DID)).toEqual([]);
  });

  it('returns active scopes', async () => {
    h.state.channelRows = [
      { channel: CHANNEL, did: OWNER, appDid: CONNECTOR_DID, scopes: ['test:read'], status: 'active' },
    ];
    expect(await readActiveConnectorScopes(OWNER, CHANNEL, CONNECTOR_DID)).toEqual(['test:read']);
  });

  it('excludes revoked rows', async () => {
    h.state.channelRows = [
      { channel: CHANNEL, did: OWNER, appDid: CONNECTOR_DID, scopes: ['test:read'], status: 'revoked' },
    ];
    expect(await readActiveConnectorScopes(OWNER, CHANNEL, CONNECTOR_DID)).toEqual([]);
  });
});

// ── connectorConsentRef ───────────────────────────────────────────────────────

describe('connectorConsentRef', () => {
  it('builds a stable ref', () => {
    expect(connectorConsentRef('asset_xyz', 'test:read')).toBe('asset_xyz:test:read');
  });
});

// ── syncConnectorConsentGrants ────────────────────────────────────────────────

describe('syncConnectorConsentGrants — grant', () => {
  const isOnConsent = (s: string) => s === 'test:write';

  it('inserts an active row for an on-consent scope', async () => {
    await syncConnectorConsentGrants(OWNER, CONNECTOR_DID, ASSET_ID, ['test:write'], isOnConsent);
    const ins = h.insertCalls.find((c) => c.table === h.F.consentGrants);
    expect(ins?.values).toMatchObject({
      subject: OWNER, grantedTo: CONNECTOR_DID, purpose: 'document.projection',
      allowedFields: ['test:write'], status: 'active', consentRef: `${ASSET_ID}:test:write`,
    });
  });

  it('does not insert a row for a silent scope', async () => {
    await syncConnectorConsentGrants(OWNER, CONNECTOR_DID, ASSET_ID, ['test:read'], isOnConsent);
    expect(h.insertCalls.filter((c) => c.table === h.F.consentGrants)).toHaveLength(0);
  });

  it('re-activates a revoked row instead of inserting a duplicate', async () => {
    h.state.consentRows = [{ ...consentRow('test:write'), status: 'revoked' }];
    await syncConnectorConsentGrants(OWNER, CONNECTOR_DID, ASSET_ID, ['test:write'], isOnConsent);
    expect(h.insertCalls.filter((c) => c.table === h.F.consentGrants)).toHaveLength(0);
    expect(h.state.consentRows[0].status).toBe('active');
  });
});

describe('syncConnectorConsentGrants — revoke', () => {
  const isOnConsent = (s: string) => s === 'test:write';

  it('revokes active rows for scopes removed from the manifest', async () => {
    h.state.consentRows = [consentRow('test:write')];
    await syncConnectorConsentGrants(OWNER, CONNECTOR_DID, ASSET_ID, [], isOnConsent);
    expect(h.state.consentRows[0].status).toBe('revoked');
  });

  it('preserves rows for scopes still in the manifest', async () => {
    h.state.consentRows = [consentRow('test:write')];
    await syncConnectorConsentGrants(OWNER, CONNECTOR_DID, ASSET_ID, ['test:write'], isOnConsent);
    expect(h.state.consentRows[0].status).toBe('active');
  });

  it('is a no-op when there are no existing active rows', async () => {
    await syncConnectorConsentGrants(OWNER, CONNECTOR_DID, ASSET_ID, [], isOnConsent);
    expect(h.updateCalls.filter((c) => c.table === h.F.consentGrants)).toHaveLength(0);
  });
});

// ── publishConnectorScopeManifest ─────────────────────────────────────────────

const publishOpts = (overrides = {}) => ({
  ownerDid: OWNER, connectorDid: CONNECTOR_DID, channel: CHANNEL,
  filename: 'test-manifest.md', scopeDescriptors: DESCRIPTORS,
  scopes: ['test:read'] as string[],
  isOnConsent: (s: string) => s === 'test:write',
  ...overrides,
});

describe('publishConnectorScopeManifest — new asset', () => {
  beforeEach(() => {
    mockCreate.mockResolvedValue({ asset: assetRow(), deduplicated: false });
  });

  it('creates asset with correct shape', async () => {
    await publishConnectorScopeManifest(publishOpts());
    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.ownerDid).toBe(OWNER);
    expect(call.filename).toBe('test-manifest.md');
    expect(call.mimeType).toBe('text/markdown');
    expect(call.dedup).toBe(false);
  });

  it('stamps metadata before updateAssetContent', async () => {
    await publishConnectorScopeManifest(publishOpts());
    const meta = h.updateCalls.find((c) => c.table === h.F.assets && typeof c.set.metadata === 'object');
    expect(meta?.set.metadata).toMatchObject({ kind: 'scope-manifest', connector: CONNECTOR_DID, channel: CHANNEL });
    expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0]);
  });

  it('returns the asset id', async () => {
    expect(await publishConnectorScopeManifest(publishOpts())).toBe(ASSET_ID);
  });

  it('throws when updateAssetContent fails', async () => {
    mockUpdate.mockResolvedValue({ ok: false, code: 'forbidden', message: 'denied' });
    await expect(publishConnectorScopeManifest(publishOpts())).rejects.toThrow(/scope-manifest update failed/);
  });
});

describe('publishConnectorScopeManifest — existing asset', () => {
  beforeEach(() => { h.state.assetRows = [assetRow()]; });

  it('skips createAsset when asset exists', async () => {
    await publishConnectorScopeManifest(publishOpts());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('still calls updateAssetContent', async () => {
    await publishConnectorScopeManifest(publishOpts());
    expect(mockUpdate).toHaveBeenCalledOnce();
  });
});
