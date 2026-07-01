import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Connector scope-manifest → channel_links surface (#1209) ────────────────
//
// Unit-level proof of the surface mechanics with the bus MOCKED so we can spy on
// publish() (the `channel.link.revoked` revoke seam). We drive apply()/remove()
// directly with hand-built released/removed sets (the reactor's job of gating is
// proven separately by projection-reactor.test.ts). A small in-memory drizzle
// fake tracks the auth.channel_links rows so we can assert real upsert / revoke
// / reconcile behavior rather than just call shapes.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { channelRows: Row[]; assetMetadata: Record<string, unknown> } = {
    channelRows: [],
    assetMetadata: { kind: 'scope-manifest' },
  };

  // Field-id markers double as the table identity (referential equality) AND
  // the column names the predicate evaluator reads off a row.
  const F = {
    assets: { id: 'id', metadata: 'metadata' },
    channelLinks: {
      id: 'id',
      channel: 'channel',
      channelUid: 'channelUid',
      did: 'did',
      appDid: 'appDid',
      scopes: 'scopes',
      status: 'status',
      revokedAt: 'revokedAt',
      createdAt: 'createdAt',
    },
  };

  type Pred = { op: string; col?: string; val?: unknown; preds?: Pred[]; vals?: unknown[] };
  const match = (row: Row, pred: Pred | undefined): boolean => {
    if (!pred) return true;
    switch (pred.op) {
      case 'eq':
        return row[pred.col as string] === pred.val;
      case 'and':
        return (pred.preds ?? []).every((p) => match(row, p));
      case 'like': {
        const pre = String(pred.val).replace(/%$/, '');
        const v = row[pred.col as string];
        return typeof v === 'string' && v.startsWith(pre);
      }
      case 'in':
        return (pred.vals ?? []).includes(row[pred.col as string]);
      default:
        return true;
    }
  };

  const resolve = (table: unknown, pred: Pred | undefined): Row[] => {
    if (table === F.assets) return [{ metadata: state.assetMetadata }];
    if (table === F.channelLinks) return state.channelRows.filter((r) => match(r, pred));
    return [];
  };

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
      values: (v: Row) => ({
        onConflictDoUpdate: ({ set }: { set: Row }) => {
          if (table === F.channelLinks) {
            const key = `${v.channel}|${v.channelUid}|${v.appDid}`;
            const existing = state.channelRows.find(
              (r) => `${r.channel}|${r.channelUid}|${r.appDid}` === key,
            );
            if (existing) Object.assign(existing, set);
            else state.channelRows.push({ ...v });
          }
          return Promise.resolve();
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (v: Row) => ({
        where: (pred: Pred) => {
          if (table === F.channelLinks) {
            for (const r of state.channelRows) if (match(r, pred)) Object.assign(r, v);
          } else if (table === F.assets && v.metadata) {
            state.assetMetadata = v.metadata as Record<string, unknown>;
          }
          return Promise.resolve();
        },
      }),
    }),
  };

  return { state, F, db };
});

vi.mock('@/src/db', () => ({ db: h.db, assets: h.F.assets, channelLinks: h.F.channelLinks }));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...preds: unknown[]) => ({ op: 'and', preds }),
  like: (col: unknown, val: unknown) => ({ op: 'like', col, val }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'in', col, vals }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn(() => Promise.resolve()) }));
vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
  broker: vi.fn(() => Promise.resolve({ status: 'rejected', reason: 'no_consent' })),
  registerReactor: vi.fn(),
  isBrokerRelease: (r: { status?: string } | null | undefined) => r?.status === 'released',
}));

import { readFile } from 'node:fs/promises';
import { channelLinksSurface } from '../channel-links-surface';
import type { ProjectionContext } from '../projection-reactor';

const OWNER = 'did:imajin:owner';
const CONNECTOR = 'did:imajin:github-connector';
const ASSET_ID = 'asset_manifest';
const PATH = '/mnt/media/owner/assets/asset_manifest.md';

const MANIFEST_HEADER = [
  '---',
  'kind: scope-manifest',
  `connector: "${CONNECTOR}"`,
  'channel: github',
  '---',
  'body',
].join('\n');

const ctx: ProjectionContext = { assetId: ASSET_ID, ownerDid: OWNER, scope: 'media', path: PATH };
const desc = (verb: string, surface: string) => ({ verb, surface, label: `${verb} ${surface}` });

function uid(scope: string): string {
  return `${ASSET_ID}#${scope}`;
}
function activeRow(scope: string): Row {
  return {
    id: `clink_${ASSET_ID}_${scope.replaceAll(':', '_')}`,
    channel: 'github',
    channelUid: uid(scope),
    did: OWNER,
    appDid: CONNECTOR,
    scopes: [scope],
    status: 'active',
    revokedAt: null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.channelRows = [];
  h.state.assetMetadata = { kind: 'scope-manifest' };
  vi.mocked(readFile).mockResolvedValue(MANIFEST_HEADER as never);
});

describe('channelLinksSurface — gate', () => {
  it('no-ops entirely for a non-manifest asset (never touches channel_links)', async () => {
    h.state.assetMetadata = { kind: 'article' };
    await channelLinksSurface.apply(ctx, { 'github:read': desc('read', 'repos') });
    await channelLinksSurface.remove(ctx, ['github:read']);
    expect(h.state.channelRows).toHaveLength(0);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('no-ops when the manifest is missing its connector identity (fail-closed)', async () => {
    vi.mocked(readFile).mockResolvedValue(['---', 'kind: scope-manifest', '---', 'body'].join('\n') as never);
    await channelLinksSurface.apply(ctx, { 'github:read': desc('read', 'repos') });
    expect(h.state.channelRows).toHaveLength(0);
  });
});

describe('channelLinksSurface — apply (grant + footprint reconcile)', () => {
  it('materializes one ACTIVE row per released scope, with only the released scopes', async () => {
    await channelLinksSurface.apply(ctx, {
      'github:read': desc('read', 'repos'),
      'github:write': desc('write', 'issues'),
    });

    const active = h.state.channelRows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(2);
    expect(active.map((r) => (r.scopes as string[])[0]).sort()).toEqual(['github:read', 'github:write']);
    expect(active.every((r) => r.appDid === CONNECTOR && r.did === OWNER)).toBe(true);
  });

  it('footprint-reconciles: revokes an active row whose scope is no longer released + publishes', async () => {
    // A previously-granted scope whose entire declaration was deleted from the
    // manifest (so the reactor cannot report it as a removed field).
    h.state.channelRows = [activeRow('github:stale')];

    await channelLinksSurface.apply(ctx, { 'github:read': desc('read', 'repos') });

    const stale = h.state.channelRows.find((r) => r.channelUid === uid('github:stale'));
    expect(stale?.status).toBe('revoked');
    expect(stale?.revokedAt).toBeInstanceOf(Date);
    expect(mockPublish).toHaveBeenCalledWith(
      'channel.link.revoked',
      expect.objectContaining({
        issuer: OWNER,
        subject: OWNER,
        scope: 'auth',
        payload: expect.objectContaining({ appDid: CONNECTOR, context_type: 'channel_link' }),
      }),
    );
  });

  it('re-adding a previously-revoked scope re-grants it (active, no revoke published)', async () => {
    h.state.channelRows = [{ ...activeRow('github:read'), status: 'revoked', revokedAt: new Date() }];

    await channelLinksSurface.apply(ctx, { 'github:read': desc('read', 'repos') });

    const row = h.state.channelRows.find((r) => r.channelUid === uid('github:read'));
    expect(row?.status).toBe('active');
    expect(row?.revokedAt).toBeNull();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('channelLinksSurface — remove (revoke on delete, #1208)', () => {
  it('flips an active scope row to revoked and publishes channel.link.revoked', async () => {
    const row = activeRow('github:write');
    h.state.channelRows = [row];

    await channelLinksSurface.remove(ctx, ['github:write']);

    expect(row.status).toBe('revoked');
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [type, envelope] = mockPublish.mock.calls[0] as unknown as [string, { payload: Record<string, unknown> }];
    expect(type).toBe('channel.link.revoked');
    expect(envelope.payload).toMatchObject({
      linkId: row.id,
      channel: 'github',
      did: OWNER,
      appDid: CONNECTOR,
      context_id: row.id,
      context_type: 'channel_link',
    });
  });

  it('is idempotent: a scope that was never materialized is a no-op (no write, no publish)', async () => {
    await channelLinksSurface.remove(ctx, ['github:write']);
    expect(h.state.channelRows).toHaveLength(0);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-revoked scope is not re-published', async () => {
    h.state.channelRows = [{ ...activeRow('github:write'), status: 'revoked', revokedAt: new Date() }];
    await channelLinksSurface.remove(ctx, ['github:write']);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
