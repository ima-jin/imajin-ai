import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── projectConsentedScopes × requireMcpGrant — end-to-end proof (#1804) ────
//
// Wires the REAL publishConnectorScopeManifest (only its I/O edges — assets,
// channel_links, consent_grants, the media asset writers — are stubbed) to
// the REAL requireMcpGrant/resolveActiveMcpGrant gate, sharing one in-memory
// `auth.channel_links` table. This is the direct proof of the #1804
// acceptance criteria:
//   1. fresh consent → requireMcpGrant passes for a granted scope, with ZERO
//      dashboard/connector-card visits;
//   2. a scope never granted on the consent screen still fails;
//   3. re-consenting (same or additional scopes) is idempotent — no
//      duplicate manifest assets, no clobbered rows.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { assetRows: Row[]; channelRows: Row[]; consentRows: Row[] } = {
    assetRows: [], channelRows: [], consentRows: [],
  };

  const F = {
    assets: { id: 'id', ownerDid: 'ownerDid', status: 'status', metadata: 'metadata' },
    channelLinks: {
      id: 'id', channel: 'channel', channelUid: 'channelUid', did: 'did', appDid: 'appDid',
      status: 'status', scopes: 'scopes', revokedAt: 'revokedAt', createdAt: 'createdAt',
    },
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
      case 'inArray': return (pred.val as unknown[]).includes(row[pred.col as string]);
      default: return true;
    }
  };

  const resolve = (table: unknown, pred: Pred | undefined): Row[] => {
    if (table === F.assets) return state.assetRows.filter((r) => match(r, pred));
    if (table === F.channelLinks) return state.channelRows.filter((r) => match(r, pred));
    if (table === F.consentGrants) return state.consentRows.filter((r) => match(r, pred));
    return [];
  };

  const db = {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: (pred: Pred) => {
          const run = () => Promise.resolve(resolve(table, pred));
          return {
            limit: (_n: number) => run(),
            then: (f: (rows: Row[]) => unknown, r: (err: unknown) => unknown) => run().then(f, r),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Row) => {
        if (table === F.consentGrants) state.consentRows.push({ ...v });
        return {
          onConflictDoUpdate: ({ set }: { set: Row }) => {
            if (table === F.channelLinks) {
              const key = `${v.channel}|${v.channelUid}|${v.appDid}`;
              const existing = state.channelRows.find((r) => `${r.channel}|${r.channelUid}|${r.appDid}` === key);
              if (existing) Object.assign(existing, set);
              else state.channelRows.push({ ...v });
            }
            return Promise.resolve();
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (v: Row) => ({
        where: (pred: Pred) => {
          if (table === F.assets) for (const r of state.assetRows) if (match(r, pred)) Object.assign(r, v);
          if (table === F.consentGrants) for (const r of state.consentRows) if (match(r, pred)) Object.assign(r, v);
          if (table === F.channelLinks) for (const r of state.channelRows) if (match(r, pred)) Object.assign(r, v);
          return Promise.resolve();
        },
      }),
    }),
  };

  return { state, F, db };
});

vi.mock('@/src/db', () => ({
  db: h.db, assets: h.F.assets, channelLinks: h.F.channelLinks, consentGrants: h.F.consentGrants,
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...preds: unknown[]) => ({ op: 'and', preds }),
  like: (col: unknown, val: unknown) => ({ op: 'like', col, val }),
  inArray: (col: unknown, val: unknown[]) => ({ op: 'inArray', col, val }),
  // findConnectorManifestAsset's sql`...` fragments only ever check
  // metadata.kind / metadata.connector — always-true here is fine, this
  // suite drives the lookup via the asset's `status`/`ownerDid` predicates.
  sql: Object.assign((_s: TemplateStringsArray, ..._v: unknown[]) => ({ op: 'sql' }), {}),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (p: string) => `${p}_${h.state.assetRows.length + h.state.channelRows.length}` }));

let assetCounter = 0;
const { mockCreate, mockUpdate, mockAddToFolder } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockAddToFolder: vi.fn(async () => undefined),
}));
vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: mockCreate }));
vi.mock('@/src/lib/media/update-asset', () => ({ updateAssetContent: mockUpdate }));
vi.mock('@/src/lib/media/folders', () => ({ addAssetToGrantsFolder: mockAddToFolder }));

import { projectConsentedScopes } from '../consent-scope-projection';
import { requireMcpGrant, resolveActiveMcpGrant } from '@/src/lib/mcp/mcp-grant';

const OWNER = 'did:imajin:owner';
const CLIENT = 'did:imajin:claude-desktop';

beforeEach(() => {
  h.state.assetRows = [];
  h.state.channelRows = [];
  h.state.consentRows = [];
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockAddToFolder.mockClear();
  assetCounter = 0;

  mockCreate.mockImplementation(async () => {
    assetCounter += 1;
    const asset = { id: `asset_${assetCounter}` };
    h.state.assetRows.push({ id: asset.id, ownerDid: OWNER, status: 'active', metadata: {} });
    return { asset, deduplicated: false };
  });
  mockUpdate.mockImplementation(async ({ assetId }: { assetId: string }) => ({
    ok: true, asset: h.state.assetRows.find((r) => r.id === assetId),
  }));
});

describe('#1804 acceptance: fresh consent unlocks requireMcpGrant with zero dashboard visits', () => {
  it('a scope granted on the OAuth consent screen passes requireMcpGrant immediately', async () => {
    await expect(requireMcpGrant(OWNER, 'media:read', CLIENT)).rejects.toThrow('mcp_no_grant');

    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    await expect(requireMcpGrant(OWNER, 'media:read', CLIENT)).resolves.toBeUndefined();
    // No connector-card / dashboard publish call happened — only the consent projection did.
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('a scope NOT granted on the consent screen still fails (the gate stays strict)', async () => {
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    await expect(requireMcpGrant(OWNER, 'media:write', CLIENT)).rejects.toThrow('mcp_no_grant');
    expect(await resolveActiveMcpGrant(OWNER, 'media:write', CLIENT)).toBe(false);
  });

  it('an on-consent scope also materialises immediately (not limited to silent-tier)', async () => {
    // media:write is on-consent tier; the decision (#1804) is explicit that
    // whatever was granted on the OAuth screen was consented, by definition.
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:write'] });

    await expect(requireMcpGrant(OWNER, 'media:write', CLIENT)).resolves.toBeUndefined();
  });
});

describe('#1804 acceptance: re-consent idempotency', () => {
  it('consenting to the same scope twice does not create a second manifest asset', async () => {
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    expect(mockCreate).toHaveBeenCalledOnce();
    await expect(requireMcpGrant(OWNER, 'media:read', CLIENT)).resolves.toBeUndefined();
  });

  it('re-consenting with an additional scope merges it in without duplicating the first', async () => {
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read', 'connections:read'] });

    expect(mockCreate).toHaveBeenCalledOnce();
    await expect(requireMcpGrant(OWNER, 'media:read', CLIENT)).resolves.toBeUndefined();
    await expect(requireMcpGrant(OWNER, 'connections:read', CLIENT)).resolves.toBeUndefined();
  });

  it('does not produce duplicate active rows for the same owner/scope/client', async () => {
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });
    await projectConsentedScopes({ ownerDid: OWNER, appDid: CLIENT, scopes: ['media:read'] });

    const activeForClient = h.state.channelRows.filter(
      (r) => r.appDid === CLIENT && r.status === 'active' && (r.scopes as string[]).includes('media:read'),
    );
    expect(activeForClient).toHaveLength(1);
  });
});
