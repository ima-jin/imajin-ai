import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── widenMcpClientScopes (#1647) ────────────────────────────────────────────
//
// Root fix for the stale-token trap: a DCR registration freezes
// `registry.apps.requested_scopes` at registration time, and the refresh grant
// intersects against exactly that column (`resolveRefreshScopes`, #1630). So a
// scope added to the vocabulary AFTER the client registered (e.g. `messages:*`
// from #1393) could never reach the JWT `scope` claim — Gate 1 blocked the tool
// call forever, no matter how many times the owner toggled the scope on.
//
// Toggling a scope in the dashboard now widens the registration too, via the
// only link between an owner DID and its client registrations: an active row in
// `auth.oauth_refresh_tokens` (userDid → clientId → registry_apps.id).
//
// The DB is mocked with in-memory rows + a predicate matcher (same shape as
// mcp-grant.test.ts). scope-manifest-core is mocked out: this file exercises the
// widen path only, and the core pulls in the whole media/asset stack.

type RefreshRow = {
  clientId: string;
  userDid: string;
  revokedAt: Date | null;
  expiresAt: Date;
};

type AppRow = {
  id: string;
  status: string;
  requestedScopes: string[] | null;
};

type Pred = { op: string; col?: string; val?: unknown; preds?: Pred[] };

const h = vi.hoisted(() => {
  const refreshRows: RefreshRow[] = [];
  const appRows: AppRow[] = [];
  /** Every `.set()` payload issued against registry_apps. */
  const updates: { clientId: string; requestedScopes: string[] }[] = [];
  /** Every message handed to log.error — proves the fire-and-forget contract. */
  const logged: unknown[] = [];
  /** Flip to make the refresh-token lookup blow up. */
  const fail = { refreshLookup: false };

  // Column sentinels: the matcher below reads rows by these string keys, so the
  // mocked drizzle helpers can carry the column name straight through.
  const oauthRefreshTokens = {
    clientId: 'clientId', userDid: 'userDid', revokedAt: 'revokedAt', expiresAt: 'expiresAt',
  };
  const registryApps = {
    id: 'id', status: 'status', requestedScopes: 'requestedScopes', updatedAt: 'updatedAt',
  };

  const match = (row: Record<string, unknown>, pred: Pred): boolean => {
    switch (pred.op) {
      case 'eq':     return row[pred.col as string] === pred.val;
      case 'isNull': return row[pred.col as string] == null;
      case 'gt':     return (row[pred.col as string] as Date) > (pred.val as Date);
      case 'and':    return (pred.preds ?? []).every((p) => match(row, p));
      default:       return true;
    }
  };

  // Flattened builder chain (keeps nesting under the lint bound).
  const distinctWhere = (pred: Pred) => {
    if (fail.refreshLookup) return Promise.reject(new Error('refresh lookup exploded'));
    const hit = refreshRows.filter((r) => match(r as unknown as Record<string, unknown>, pred));
    return Promise.resolve(hit.map((r) => ({ clientId: r.clientId })));
  };
  const selectDistinct = () => ({ from: () => ({ where: distinctWhere }) });

  const appLimit = (pred: Pred) => async () =>
    appRows
      .filter((r) => match(r as unknown as Record<string, unknown>, pred))
      .map((r) => ({ requestedScopes: r.requestedScopes }));
  const selectWhere = (pred: Pred) => ({ limit: appLimit(pred) });
  const select = () => ({ from: () => ({ where: selectWhere }) });

  const updateWhere = (values: Record<string, unknown>) => async (pred: Pred) => {
    const scopes = values.requestedScopes as string[];
    for (const row of appRows) {
      if (!match(row as unknown as Record<string, unknown>, pred)) continue;
      row.requestedScopes = scopes;
      updates.push({ clientId: row.id, requestedScopes: scopes });
    }
  };
  const set = (values: Record<string, unknown>) => ({ where: updateWhere(values) });
  const update = () => ({ set });

  return {
    refreshRows, appRows, updates, logged, fail,
    oauthRefreshTokens, registryApps,
    db: { selectDistinct, select, update },
  };
});

vi.mock('@/src/db', () => ({
  db: h.db,
  oauthRefreshTokens: h.oauthRefreshTokens,
  registryApps: h.registryApps,
}));

vi.mock('drizzle-orm', () => ({
  eq:     (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and:    (...preds: unknown[])        => ({ op: 'and', preds }),
  isNull: (col: unknown)               => ({ op: 'isNull', col }),
  gt:     (col: unknown, val: unknown) => ({ op: 'gt', col, val }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((ctx: unknown) => { h.logged.push(ctx); }),
  }),
}));

// The core owns the publish/asset machinery, which this path never touches.
vi.mock('@/src/lib/kernel/scope-manifest-core', () => ({
  buildConnectorManifestContent: vi.fn(),
  findConnectorManifestAsset: vi.fn(),
  readActiveConnectorScopes: vi.fn(),
  syncConnectorConsentGrants: vi.fn(),
  publishConnectorScopeManifest: vi.fn(),
}));

import { widenMcpClientScopes, VALID_MCP_SCOPES } from '../scope-manifest';

const OWNER = 'did:imajin:owner';
const OTHER = 'did:imajin:someone-else';
const CLIENT_A = 'app_claude_desktop';
const CLIENT_B = 'app_mcp_inspector';
const OFF_CEILING = 'totally:not-a-real-scope';

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * 24 * HOUR);
const past = () => new Date(Date.now() - HOUR);

function activeToken(clientId: string, userDid = OWNER): RefreshRow {
  return { clientId, userDid, revokedAt: null, expiresAt: future() };
}

function app(id: string, requestedScopes: string[] | null, status = 'active'): AppRow {
  return { id, status, requestedScopes };
}

/** Current `requestedScopes` on a registration row. */
function scopesOf(id: string): string[] | null | undefined {
  return h.appRows.find((r) => r.id === id)?.requestedScopes;
}

beforeEach(() => {
  h.refreshRows.splice(0);
  h.appRows.splice(0);
  h.updates.splice(0);
  h.logged.splice(0);
  h.fail.refreshLookup = false;
});

describe('fixture sanity', () => {
  it('has the scopes these tests toggle', () => {
    expect(VALID_MCP_SCOPES).toContain('media:read');
    expect(VALID_MCP_SCOPES).toContain('messages:read');
    expect(VALID_MCP_SCOPES).not.toContain(OFF_CEILING);
  });
});

describe('widenMcpClientScopes — widens a frozen registration', () => {
  beforeEach(() => {
    h.refreshRows.push(activeToken(CLIENT_A));
    h.appRows.push(app(CLIENT_A, ['media:read']));
  });

  it('adds the newly toggled scope to requestedScopes', async () => {
    await widenMcpClientScopes(OWNER, ['media:read', 'messages:read']);
    expect(scopesOf(CLIENT_A)).toEqual(['media:read', 'messages:read']);
  });

  it('issues exactly one update', async () => {
    await widenMcpClientScopes(OWNER, ['media:read', 'messages:read']);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].clientId).toBe(CLIENT_A);
  });

  it('is a union, never a replace — pre-existing scopes survive', async () => {
    await widenMcpClientScopes(OWNER, ['messages:read']);
    expect(scopesOf(CLIENT_A)).toEqual(['media:read', 'messages:read']);
  });

  it('is idempotent — a second identical call issues no further update', async () => {
    await widenMcpClientScopes(OWNER, ['media:read', 'messages:read']);
    await widenMcpClientScopes(OWNER, ['media:read', 'messages:read']);
    expect(h.updates).toHaveLength(1);
  });

  it('treats a legacy null requestedScopes as empty rather than crashing', async () => {
    h.appRows.splice(0, h.appRows.length, app(CLIENT_A, null));
    await widenMcpClientScopes(OWNER, ['messages:read']);
    expect(scopesOf(CLIENT_A)).toEqual(['messages:read']);
  });

  it('ignores registrations belonging to another owner DID', async () => {
    h.refreshRows.splice(0, h.refreshRows.length, activeToken(CLIENT_A, OTHER));
    await widenMcpClientScopes(OWNER, ['messages:read']);
    expect(h.updates).toHaveLength(0);
    expect(scopesOf(CLIENT_A)).toEqual(['media:read']);
  });
});

describe('widenMcpClientScopes — no-op when nothing to add', () => {
  it('issues no update when every scope is already registered', async () => {
    h.refreshRows.push(activeToken(CLIENT_A));
    h.appRows.push(app(CLIENT_A, ['media:read', 'messages:read']));

    await widenMcpClientScopes(OWNER, ['media:read', 'messages:read']);

    expect(h.updates).toHaveLength(0);
    expect(scopesOf(CLIENT_A)).toEqual(['media:read', 'messages:read']);
  });

  it('issues no update when the publish carried no scopes at all', async () => {
    h.refreshRows.push(activeToken(CLIENT_A));
    h.appRows.push(app(CLIENT_A, ['media:read']));

    await widenMcpClientScopes(OWNER, []);

    expect(h.updates).toHaveLength(0);
  });

  it('skips a registration that is no longer active', async () => {
    h.refreshRows.push(activeToken(CLIENT_A));
    h.appRows.push(app(CLIENT_A, ['media:read'], 'revoked'));

    await widenMcpClientScopes(OWNER, ['messages:read']);

    expect(h.updates).toHaveLength(0);
  });
});

describe('widenMcpClientScopes — never widens past the MCP ceiling', () => {
  beforeEach(() => {
    h.refreshRows.push(activeToken(CLIENT_A));
    h.appRows.push(app(CLIENT_A, ['media:read']));
  });

  it('drops a scope outside VALID_MCP_SCOPES', async () => {
    await widenMcpClientScopes(OWNER, ['messages:read', OFF_CEILING]);
    expect(scopesOf(CLIENT_A)).toEqual(['media:read', 'messages:read']);
    expect(scopesOf(CLIENT_A)).not.toContain(OFF_CEILING);
  });

  it('issues no update when the only new scope is off-ceiling', async () => {
    await widenMcpClientScopes(OWNER, ['media:read', OFF_CEILING]);
    expect(h.updates).toHaveLength(0);
  });
});

describe('widenMcpClientScopes — multiple client registrations', () => {
  it('widens every client the owner has a live session with', async () => {
    h.refreshRows.push(activeToken(CLIENT_A), activeToken(CLIENT_B));
    h.appRows.push(app(CLIENT_A, ['media:read']), app(CLIENT_B, ['connections:read']));

    await widenMcpClientScopes(OWNER, ['messages:read']);

    expect(scopesOf(CLIENT_A)).toEqual(['media:read', 'messages:read']);
    expect(scopesOf(CLIENT_B)).toEqual(['connections:read', 'messages:read']);
    expect(h.updates.map((u) => u.clientId).sort()).toEqual([CLIENT_A, CLIENT_B].sort());
  });

  it('de-duplicates a client holding several live refresh tokens', async () => {
    h.refreshRows.push(activeToken(CLIENT_A), activeToken(CLIENT_A));
    h.appRows.push(app(CLIENT_A, ['media:read']));

    await widenMcpClientScopes(OWNER, ['messages:read']);

    expect(h.updates).toHaveLength(1);
  });
});

describe('widenMcpClientScopes — only live refresh tokens count', () => {
  it('ignores a revoked refresh token', async () => {
    h.refreshRows.push({ ...activeToken(CLIENT_A), revokedAt: new Date() });
    h.appRows.push(app(CLIENT_A, ['media:read']));

    await widenMcpClientScopes(OWNER, ['messages:read']);

    expect(h.updates).toHaveLength(0);
    expect(scopesOf(CLIENT_A)).toEqual(['media:read']);
  });

  it('ignores an expired refresh token', async () => {
    h.refreshRows.push({ ...activeToken(CLIENT_A), expiresAt: past() });
    h.appRows.push(app(CLIENT_A, ['media:read']));

    await widenMcpClientScopes(OWNER, ['messages:read']);

    expect(h.updates).toHaveLength(0);
  });

  it('widens only the client whose token is still live', async () => {
    h.refreshRows.push(activeToken(CLIENT_A), { ...activeToken(CLIENT_B), revokedAt: new Date() });
    h.appRows.push(app(CLIENT_A, ['media:read']), app(CLIENT_B, ['media:read']));

    await widenMcpClientScopes(OWNER, ['messages:read']);

    expect(h.updates.map((u) => u.clientId)).toEqual([CLIENT_A]);
    expect(scopesOf(CLIENT_B)).toEqual(['media:read']);
  });

  it('does nothing when the owner has no MCP session at all', async () => {
    h.appRows.push(app(CLIENT_A, ['media:read']));

    await expect(widenMcpClientScopes(OWNER, ['messages:read'])).resolves.toBeUndefined();

    expect(h.updates).toHaveLength(0);
    expect(h.logged).toHaveLength(0);
  });
});

describe('widenMcpClientScopes — fire-and-forget contract', () => {
  it('does not throw when the DB errors, and logs instead', async () => {
    h.fail.refreshLookup = true;

    await expect(widenMcpClientScopes(OWNER, ['messages:read'])).resolves.toBeUndefined();

    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatchObject({ ownerDid: OWNER });
  });
});
