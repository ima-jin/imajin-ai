import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Discord scope-manifest publisher unit tests (#1355) ─────────────────────
// Mirrors the GitHub scope-manifest test structure exactly.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { assetRows: Row[]; channelRows: Row[]; consentRows: Row[] } = {
    assetRows: [],
    channelRows: [],
    consentRows: [],
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
        const v = row[pred.col as string];
        return typeof v === 'string' && v.startsWith(prefix);
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
          if (table === F.assets) {
            for (const r of state.assetRows) if (match(r, pred)) Object.assign(r, v);
          }
          if (table === F.consentGrants) {
            for (const r of state.consentRows) if (match(r, pred)) Object.assign(r, v);
          }
          return Promise.resolve();
        },
      }),
    }),
  };

  return { state, F, db, updateCalls, insertCalls };
});

vi.mock('@/src/db', () => ({
  db: h.db,
  assets: h.F.assets,
  channelLinks: h.F.channelLinks,
  consentGrants: h.F.consentGrants,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...preds: unknown[]) => ({ op: 'and', preds }),
  like: (col: unknown, val: unknown) => ({ op: 'like', col, val }),
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
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

// Vault mock — not needed for manifest tests but imported transitively.
vi.mock('@/src/lib/vault', () => ({ vaultFieldExists: vi.fn().mockResolvedValue(false) }));

vi.mock('../connector', () => ({
  DISCORD_CONNECTOR_DID: 'did:imajin:discord-connector',
  vaultField: (did: string) => `discord-bot-token:${did}`,
}));

import {
  buildManifestContent,
  findDiscordManifestAsset,
  readActiveDiscordScopes,
  publishDiscordScopeManifest,
  syncConsentGrants,
  VALID_DISCORD_SCOPES,
  DISCORD_SCOPE_DESCRIPTORS,
} from '../scope-manifest';
import { DISCORD_CONNECTOR_DID } from '../connector';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OWNER = 'did:imajin:jin';
const ASSET_ID = 'asset_discord_manifest_001';
const MANIFEST_ID = 'asset_manifest_disc';

function manifestAssetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSET_ID,
    ownerDid: OWNER,
    status: 'active',
    metadata: { kind: 'scope-manifest', connector: DISCORD_CONNECTOR_DID, channel: 'discord' },
    storagePath: '/mnt/media/owner/assets/asset_discord_manifest.md',
    ...overrides,
  };
}

function channelRow(scope: string, status = 'active'): Row {
  return { channel: 'discord', did: OWNER, appDid: DISCORD_CONNECTOR_DID, scopes: [scope], status };
}

function activeConsentRow(scope: string): Row {
  return {
    id: `cgrant_${scope.replaceAll(':', '_')}`,
    subject: OWNER, grantedTo: DISCORD_CONNECTOR_DID, purpose: 'document.projection',
    allowedFields: [scope], mode: 'attestation', status: 'active',
    consentRef: `${MANIFEST_ID}:${scope}`,
  };
}

beforeEach(() => {
  h.state.assetRows = [];
  h.state.channelRows = [];
  h.state.consentRows = [];
  h.updateCalls.length = 0;
  h.insertCalls.length = 0;
  mockCreateAsset.mockReset();
  mockUpdateAssetContent.mockReset();
  mockUpdateAssetContent.mockResolvedValue({ ok: true, asset: manifestAssetRow() });
});

// ── buildManifestContent ──────────────────────────────────────────────────────

describe('buildManifestContent', () => {
  it('includes required header fields', () => {
    const c = buildManifestContent(['discord:post']);
    expect(c).toContain('kind: scope-manifest');
    expect(c).toContain(`connector: "${DISCORD_CONNECTOR_DID}"`);
    expect(c).toContain('channel: discord');
  });

  it('includes only requested scopes', () => {
    const c = buildManifestContent(['discord:post']);
    expect(c).toContain('"discord:post":');
    expect(c).not.toContain('"discord:read":');
  });

  it('includes both scopes when requested', () => {
    const c = buildManifestContent(['discord:post', 'discord:read']);
    expect(c).toContain('"discord:post":');
    expect(c).toContain('"discord:read":');
  });

  it('emits a release: block with viewer for on-consent scopes', () => {
    const c = buildManifestContent(['discord:post']);
    expect(c).toContain('release:');
    expect(c).toContain('discloses_others: true');
    expect(c).toContain(`viewer: "${DISCORD_CONNECTOR_DID}"`);
  });

  it('drops unknown scope names', () => {
    const c = buildManifestContent(['discord:post', 'discord:unknown']);
    expect(c).not.toContain('"discord:unknown":');
  });

  it('produces valid YAML delimiters', () => {
    const lines = buildManifestContent(['discord:post']).split('\n');
    expect(lines[0]).toBe('---');
    expect(lines.indexOf('---', 1)).toBeGreaterThan(1);
  });

  it('VALID_DISCORD_SCOPES lists both known scopes', () => {
    expect(new Set(VALID_DISCORD_SCOPES)).toEqual(new Set(['discord:post', 'discord:read']));
  });

  it('both scopes are on-consent (discloses_others: true)', () => {
    for (const scope of VALID_DISCORD_SCOPES) {
      expect(DISCORD_SCOPE_DESCRIPTORS[scope].release.discloses_others).toBe(true);
    }
  });
});

// ── findDiscordManifestAsset ──────────────────────────────────────────────────

describe('findDiscordManifestAsset', () => {
  it('returns null when no asset exists', async () => {
    expect(await findDiscordManifestAsset(OWNER)).toBeNull();
  });

  it('returns the matching asset', async () => {
    h.state.assetRows = [manifestAssetRow()];
    const r = await findDiscordManifestAsset(OWNER);
    expect(r?.id).toBe(ASSET_ID);
  });

  it('does not return assets belonging to a different owner', async () => {
    h.state.assetRows = [manifestAssetRow({ ownerDid: 'did:imajin:other' })];
    expect(await findDiscordManifestAsset(OWNER)).toBeNull();
  });

  it('does not return deleted assets', async () => {
    h.state.assetRows = [manifestAssetRow({ status: 'deleted' })];
    expect(await findDiscordManifestAsset(OWNER)).toBeNull();
  });
});

// ── readActiveDiscordScopes ───────────────────────────────────────────────────

describe('readActiveDiscordScopes', () => {
  it('returns empty array when no rows', async () => {
    expect(await readActiveDiscordScopes(OWNER)).toEqual([]);
  });

  it('returns active scopes', async () => {
    h.state.channelRows = [channelRow('discord:post'), channelRow('discord:read')];
    const scopes = await readActiveDiscordScopes(OWNER);
    expect(scopes.sort()).toEqual(['discord:post', 'discord:read']);
  });

  it('excludes revoked rows', async () => {
    h.state.channelRows = [channelRow('discord:post'), channelRow('discord:read', 'revoked')];
    expect(await readActiveDiscordScopes(OWNER)).toEqual(['discord:post']);
  });
});

// ── syncConsentGrants ─────────────────────────────────────────────────────────

describe('syncConsentGrants — grant path', () => {
  it('inserts active consent_grants row for discord:post (on-consent)', async () => {
    await syncConsentGrants(OWNER, MANIFEST_ID, ['discord:post']);
    const ins = h.insertCalls.find((c) => c.table === h.F.consentGrants);
    expect(ins?.values).toMatchObject({
      subject: OWNER, grantedTo: DISCORD_CONNECTOR_DID, purpose: 'document.projection',
      allowedFields: ['discord:post'], status: 'active',
      consentRef: `${MANIFEST_ID}:discord:post`,
    });
  });

  it('inserts row for discord:read (also on-consent)', async () => {
    await syncConsentGrants(OWNER, MANIFEST_ID, ['discord:read']);
    const ins = h.insertCalls.filter((c) => c.table === h.F.consentGrants);
    expect(ins).toHaveLength(1);
    expect(ins[0].values).toMatchObject({ allowedFields: ['discord:read'] });
  });

  it('re-activates a revoked row instead of inserting a duplicate', async () => {
    h.state.consentRows = [{ ...activeConsentRow('discord:post'), status: 'revoked' }];
    await syncConsentGrants(OWNER, MANIFEST_ID, ['discord:post']);
    expect(h.insertCalls.filter((c) => c.table === h.F.consentGrants)).toHaveLength(0);
    expect(h.state.consentRows[0].status).toBe('active');
  });
});

describe('syncConsentGrants — revoke path', () => {
  it('revokes active rows for scopes removed from the manifest', async () => {
    h.state.consentRows = [activeConsentRow('discord:post')];
    await syncConsentGrants(OWNER, MANIFEST_ID, []);
    expect(h.state.consentRows[0].status).toBe('revoked');
  });

  it('preserves rows for scopes still in the manifest', async () => {
    h.state.consentRows = [activeConsentRow('discord:post'), activeConsentRow('discord:read')];
    await syncConsentGrants(OWNER, MANIFEST_ID, ['discord:post']);
    const post = h.state.consentRows.find((r) => r.consentRef === `${MANIFEST_ID}:discord:post`);
    const read = h.state.consentRows.find((r) => r.consentRef === `${MANIFEST_ID}:discord:read`);
    expect(post?.status).toBe('active');
    expect(read?.status).toBe('revoked');
  });

  it('is a no-op when no existing rows', async () => {
    await syncConsentGrants(OWNER, MANIFEST_ID, []);
    expect(h.updateCalls.filter((c) => c.table === h.F.consentGrants)).toHaveLength(0);
  });
});

// ── publishDiscordScopeManifest ───────────────────────────────────────────────

describe('publishDiscordScopeManifest — new manifest', () => {
  beforeEach(() => {
    mockCreateAsset.mockResolvedValue({ asset: manifestAssetRow(), deduplicated: false });
  });

  it('creates asset with correct shape', async () => {
    await publishDiscordScopeManifest(OWNER, ['discord:post']);
    expect(mockCreateAsset).toHaveBeenCalledOnce();
    const call = mockCreateAsset.mock.calls[0][0] as Record<string, unknown>;
    expect(call.ownerDid).toBe(OWNER);
    expect(call.filename).toBe('discord-scope-manifest.md');
    expect(call.mimeType).toBe('text/markdown');
    expect(call.access).toBe('private');
    expect(call.dedup).toBe(false);
  });

  it('stamps metadata before updateAssetContent', async () => {
    await publishDiscordScopeManifest(OWNER, ['discord:post']);
    const meta = h.updateCalls.find((c) => c.table === h.F.assets && typeof c.set.metadata === 'object');
    expect(meta?.set.metadata).toMatchObject({ kind: 'scope-manifest', connector: DISCORD_CONNECTOR_DID, channel: 'discord' });
    const createOrder = mockCreateAsset.mock.invocationCallOrder[0];
    const updateOrder = mockUpdateAssetContent.mock.invocationCallOrder[0];
    expect(updateOrder).toBeGreaterThan(createOrder);
  });

  it('writes consent_grants before updateAssetContent', async () => {
    await publishDiscordScopeManifest(OWNER, ['discord:post']);
    expect(h.insertCalls.filter((c) => c.table === h.F.consentGrants)).toHaveLength(1);
    expect(mockUpdateAssetContent).toHaveBeenCalledOnce();
  });

  it('returns the asset id', async () => {
    expect(await publishDiscordScopeManifest(OWNER, ['discord:post'])).toBe(ASSET_ID);
  });

  it('throws when updateAssetContent fails', async () => {
    mockUpdateAssetContent.mockResolvedValue({ ok: false, code: 'forbidden', message: 'denied' });
    await expect(publishDiscordScopeManifest(OWNER, ['discord:post'])).rejects.toThrow(/discord scope-manifest update failed/);
  });
});

describe('publishDiscordScopeManifest — existing manifest', () => {
  beforeEach(() => { h.state.assetRows = [manifestAssetRow()]; });

  it('skips createAsset on subsequent calls', async () => {
    await publishDiscordScopeManifest(OWNER, ['discord:post']);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('still writes consent_grants on update', async () => {
    await publishDiscordScopeManifest(OWNER, ['discord:post', 'discord:read']);
    expect(h.insertCalls.filter((c) => c.table === h.F.consentGrants)).toHaveLength(2);
  });

  it('empty scopes produces a manifest with no scope rows', async () => {
    await publishDiscordScopeManifest(OWNER, []);
    const { content } = mockUpdateAssetContent.mock.calls[0][0] as { content: string };
    expect(content).not.toContain('"discord:post":');
    expect(content).toContain('kind: scope-manifest');
  });
});
