import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ─── Scope manifest END-TO-END proof (#1209, EPIC #1204) ─────────────────────
//
// The whole thesis on a real surface: a connector's scopes live in a userspace
// SCOPE MANIFEST (the #1203 GitHub fixture). Editing the manifest drives the
// REAL release-gated reactor (#1207) + REAL broker latch, projecting through the
// connector channel_links surface (#1209) into the live permission DB:
//
//   grant (silent / consented)   → an ACTIVE auth.channel_links row appears
//   gated (unconsented / never)  → NO row
//   delete a scope (#1208)       → row flips to revoked (+ channel.link.revoked)
//   re-add                       → active again
//
// Only the I/O edges are stubbed (mirrors projection-reactor.test.ts):
//   - @/src/db        → an in-memory drizzle fake for auth.channel_links + the
//                       manifest asset row (metadata.kind = 'scope-manifest')
//   - @imajin/db      → the raw SQL client the broker reactors reach through
//                       (bus_chain_configs → default chain; consent_grants →
//                       a grant to the connector for `github:write` ONLY)
//   - node:fs/promises→ the manifest bytes the reactor + surface read
// @imajin/bus is REAL — the actual broker() latch decides each scope, and the
// surface's channel.link.revoked publish runs the real bus.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { channelRows: Row[]; assetMetadata: Record<string, unknown> } = {
    channelRows: [],
    assetMetadata: { kind: 'scope-manifest' },
  };

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

// Raw SQL client the broker's consent/config/audit reactors reach through. The
// owner has consented to `github:write` ONLY (granted to the connector DID),
// proving on-consent gating: github:write releases, github:org does not.
vi.mock('@imajin/db', () => {
  const sql = (strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('consent_grants')) {
      if (q.includes('granted_to_class')) return Promise.resolve([]);
      return Promise.resolve([
        {
          allowed_fields: ['github:write'],
          mode: 'attestation',
          consent_ref: 'consent-gh-write',
          granted_to: 'did:imajin:github-connector',
          purpose: 'document.projection',
        },
      ]);
    }
    return Promise.resolve([]); // bus_chain_configs → default chain; audit → ok
  };
  return { getClient: () => sql };
});

import { readFile } from 'node:fs/promises';
import { projectReactor } from '../projection-reactor';
import { ensureChannelLinksSurfaceRegistered } from '../channel-links-surface';
import type { BusEvent } from '@imajin/bus';

const OWNER = 'did:imajin:owner';
const CONNECTOR = 'did:imajin:github-connector';
const ASSET_ID = 'asset_github_manifest';
const PATH = '/mnt/media/owner/assets/asset_github_manifest.md';

// The real #1203 GitHub scope-manifest fixture.
const FIXTURE = readFileSync(new URL('./fixtures/github-scope-manifest.md', import.meta.url), 'utf-8');

// An edit that DELETES the github:write declaration entirely (both its data row
// and its release entry) — exercising the footprint-reconcile deletion gap.
const MANIFEST_WITHOUT_WRITE = [
  '---',
  'kind: scope-manifest',
  `connector: "${CONNECTOR}"`,
  'channel: github',
  '"github:read":',
  '  verb: read',
  '  surface: repos',
  '  label: "Read your own repos"',
  '"github:org":',
  '  verb: write',
  '  surface: org',
  '  label: "Act on org repos"',
  '"github:actions":',
  '  verb: execute',
  '  surface: actions',
  '  label: "Trigger Actions"',
  'release:',
  '  "github:read":',
  '    discloses_others: false',
  '    sensitive: false',
  '  "github:org":',
  '    discloses_others: true',
  '    sensitive: false',
  `    viewer: "${CONNECTOR}"`,
  '  "github:actions":',
  '    discloses_others: true',
  '    sensitive: true',
  '---',
  'body',
].join('\n');

function event(): BusEvent {
  return {
    type: 'document.changed',
    issuer: OWNER,
    subject: ASSET_ID,
    scope: 'media',
    payload: { path: PATH, cid: 'cid-new', prevCid: 'cid-old' },
    timestamp: new Date().toISOString(),
  };
}

function activeScopes(): string[] {
  return h.state.channelRows
    .filter((r) => r.status === 'active')
    .map((r) => (r.scopes as string[])[0])
    .sort();
}
function rowFor(scope: string): Row | undefined {
  return h.state.channelRows.find((r) => r.channelUid === `${ASSET_ID}#${scope}`);
}

beforeAll(() => {
  ensureChannelLinksSurfaceRegistered();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.state.channelRows = [];
  h.state.assetMetadata = { kind: 'scope-manifest' };
});

describe('scope manifest end-to-end (#1209): grant → gate → revoke → re-grant by file edit', () => {
  it('grant: only released scopes materialize as ACTIVE channel_links rows', async () => {
    vi.mocked(readFile).mockResolvedValue(FIXTURE as never);

    await projectReactor(event(), {});

    // github:read (silent) + github:write (on-consent, consented) → active.
    // github:org (on-consent, NOT consented) + github:actions (never) → NO row.
    expect(activeScopes()).toEqual(['github:read', 'github:write']);
    expect(rowFor('github:org')).toBeUndefined();
    expect(rowFor('github:actions')).toBeUndefined();

    const write = rowFor('github:write');
    expect(write).toMatchObject({ status: 'active', did: OWNER, appDid: CONNECTOR, scopes: ['github:write'] });
  });

  it('revoke: deleting a scope from the manifest flips its row to revoked', async () => {
    // Run 1: grant read + write.
    vi.mocked(readFile).mockResolvedValue(FIXTURE as never);
    await projectReactor(event(), {});
    expect(activeScopes()).toEqual(['github:read', 'github:write']);

    // Run 2: edit deletes the github:write declaration → footprint-reconcile
    // revokes its active row; github:read stays active.
    vi.mocked(readFile).mockResolvedValue(MANIFEST_WITHOUT_WRITE as never);
    await projectReactor(event(), {});

    expect(rowFor('github:write')).toMatchObject({ status: 'revoked' });
    expect(rowFor('github:write')?.revokedAt).toBeInstanceOf(Date);
    expect(activeScopes()).toEqual(['github:read']);
  });

  it('re-grant: re-adding the deleted scope re-activates its row', async () => {
    vi.mocked(readFile).mockResolvedValue(FIXTURE as never);
    await projectReactor(event(), {});
    vi.mocked(readFile).mockResolvedValue(MANIFEST_WITHOUT_WRITE as never);
    await projectReactor(event(), {});
    expect(rowFor('github:write')).toMatchObject({ status: 'revoked' });

    // Re-add: manifest restored → github:write re-grants (active, revokedAt cleared).
    vi.mocked(readFile).mockResolvedValue(FIXTURE as never);
    await projectReactor(event(), {});

    expect(rowFor('github:write')).toMatchObject({ status: 'active', revokedAt: null });
    expect(activeScopes()).toEqual(['github:read', 'github:write']);
  });

  it('gate: a non-manifest asset never produces channel_links rows', async () => {
    h.state.assetMetadata = { kind: 'article' };
    vi.mocked(readFile).mockResolvedValue(FIXTURE as never);

    await projectReactor(event(), {});

    expect(h.state.channelRows).toHaveLength(0);
  });
});
