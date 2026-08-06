import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── syncConnectorConsentGrants — idempotency regression cover (#1647) ───────
//
// Bug 2 of #1647: a connector scope that had been revoked (because the owner
// removed it from the manifest) never came back when the scope was re-published
// — the MCP tool then failed Gate 2 forever even though the owner had just
// re-granted it. `syncConnectorConsentGrants` is the only writer of
// `kernel.consent_grants` for connector manifests, so the invariant belongs
// here: the function must be a pure convergence step. Given the same
// (owner, connector, manifest, scopes) it must always leave the table in the
// same state, no matter how many times it runs or what the prior state was.
//
// These tests drive the REAL function against an in-memory `kernel.consent_grants`
// so both the SQL shape (consentRef keying, the LIKE sweep) and the convergence
// behaviour are exercised. Only the db/id edges are mocked.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state: { consentRows: Record<string, unknown>[] } = { consentRows: [] };

  // Column sentinels — the mocked predicate builders carry these through, so
  // `match()` can read the right property off an in-memory row.
  const F = {
    assets: { id: 'id', ownerDid: 'ownerDid', status: 'status', metadata: 'metadata' },
    channelLinks: {
      id: 'id', channel: 'channel', channelUid: 'channelUid', did: 'did',
      appDid: 'appDid', status: 'status', scopes: 'scopes',
      revokedAt: 'revokedAt', createdAt: 'createdAt',
    },
    consentGrants: {
      id: 'id', subject: 'subject', grantedTo: 'grantedTo', purpose: 'purpose',
      allowedFields: 'allowedFields', mode: 'mode', status: 'status',
      consentRef: 'consentRef', updatedAt: 'updatedAt',
    },
  };

  type P = { op: string; col?: string; val?: unknown; preds?: P[] };
  const match = (row: Record<string, unknown>, pred: P | undefined): boolean => {
    if (!pred) return true;
    switch (pred.op) {
      case 'eq': return row[pred.col as string] === pred.val;
      case 'and': return (pred.preds ?? []).every((p) => match(row, p));
      case 'like': {
        const prefix = String(pred.val).replace(/%$/, '');
        const value = row[pred.col as string];
        return typeof value === 'string' && value.startsWith(prefix);
      }
      default: return true;
    }
  };

  /** Every `.values()` payload written to consent_grants. */
  const inserts: Record<string, unknown>[] = [];
  /** Every `.set()` payload written to consent_grants. */
  const updates: Record<string, unknown>[] = [];

  let seq = 0;
  const nextSeq = () => `${++seq}`;
  const resetSeq = () => { seq = 0; };

  const rowsFor = (table: unknown, pred: P | undefined) =>
    table === F.consentGrants ? state.consentRows.filter((r) => match(r, pred)) : [];

  // Flattened builder chain (keeps the nesting under the lint bound).
  // `where()` is awaited directly by the LIKE sweep and chained into `.limit()`
  // by the consentRef lookup, so it must be both thenable and chainable.
  const runQuery = (table: unknown, pred: P) => () => Promise.resolve(rowsFor(table, pred));
  const selectWhere = (table: unknown) => (pred: P) => {
    const run = runQuery(table, pred);
    type Rows = Record<string, unknown>[];
    return {
      limit: (_n: number) => run(),
      then: (onOk: (v: Rows) => unknown, onErr?: (e: unknown) => unknown) => run().then(onOk, onErr),
    };
  };
  const select = (_projection?: unknown) => ({
    from: (table: unknown) => ({ where: selectWhere(table) }),
  });

  const insertValues = (table: unknown) => async (v: Record<string, unknown>) => {
    if (table !== F.consentGrants) return;
    inserts.push({ ...v });
    state.consentRows.push({ ...v });
  };
  const insert = (table: unknown) => ({ values: insertValues(table) });

  const updateWhere = (table: unknown, v: Record<string, unknown>) => async (pred: P) => {
    if (table !== F.consentGrants) return;
    updates.push({ ...v });
    for (const r of state.consentRows) if (match(r, pred)) Object.assign(r, v);
  };
  const update = (table: unknown) => ({
    set: (v: Record<string, unknown>) => ({ where: updateWhere(table, v) }),
  });

  return { state, F, db: { select, insert, update }, inserts, updates, nextSeq, resetSeq };
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
  sql: Object.assign((_s: TemplateStringsArray, ..._v: unknown[]) => ({ op: 'sql' }), {}),
}));

// Distinct ids per insert — the update path keys on `eq(consentGrants.id, …)`,
// so a constant id would let one update bleed across unrelated rows.
vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${h.nextSeq()}`,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));
vi.mock('@/src/lib/media/create-asset', () => ({ createAsset: vi.fn() }));
vi.mock('@/src/lib/media/update-asset', () => ({ updateAssetContent: vi.fn() }));
vi.mock('@/src/lib/media/folders', () => ({
  addAssetToGrantsFolder: vi.fn().mockResolvedValue(undefined),
  getOrCreateSystemFolder: vi.fn().mockResolvedValue('folder_test'),
}));

import { syncConnectorConsentGrants, connectorConsentRef } from '../scope-manifest-core';

const OWNER = 'did:imajin:owner';
const CONNECTOR_DID = 'did:imajin:media-connector';
const ASSET_ID = 'asset_sync_test';

const WRITE = 'media:write';
const READ = 'media:read';
const MESSAGES = 'messages:write';

/** Only the two write scopes sit behind a consent barrier; reads are silent. */
const isOnConsent = (scopeName: string) => scopeName === WRITE || scopeName === MESSAGES;

async function sync(scopes: readonly string[]) {
  await syncConnectorConsentGrants(OWNER, CONNECTOR_DID, ASSET_ID, scopes, isOnConsent);
}

/** The single consent_grants row for `scope`, or undefined. */
function grantFor(scope: string): Row | undefined {
  const ref = connectorConsentRef(ASSET_ID, scope);
  return h.state.consentRows.find((r) => r.consentRef === ref);
}

function grantsFor(scope: string): Row[] {
  const ref = connectorConsentRef(ASSET_ID, scope);
  return h.state.consentRows.filter((r) => r.consentRef === ref);
}

function seedGrant(scope: string, status: 'active' | 'revoked'): Row {
  const row: Row = {
    id: `cg_seeded_${scope}`,
    subject: OWNER,
    grantedTo: CONNECTOR_DID,
    purpose: 'document.projection',
    allowedFields: [scope],
    mode: 'attestation',
    status,
    consentRef: connectorConsentRef(ASSET_ID, scope),
  };
  h.state.consentRows.push(row);
  return row;
}

beforeEach(() => {
  h.state.consentRows = [];
  h.inserts.length = 0;
  h.updates.length = 0;
  h.resetSeq();
});

// ── Grant path ────────────────────────────────────────────────────────────────

describe('syncConnectorConsentGrants — creates grants for on-consent scopes', () => {
  it('inserts one active row keyed by the stable consentRef', async () => {
    await sync([WRITE]);

    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({
      subject: OWNER,
      grantedTo: CONNECTOR_DID,
      purpose: 'document.projection',
      allowedFields: [WRITE],
      mode: 'attestation',
      status: 'active',
      consentRef: `${ASSET_ID}:${WRITE}`,
    });
    expect(grantFor(WRITE)).toMatchObject({ status: 'active' });
  });

  it('does not touch consent_grants for a silent scope', async () => {
    await sync([READ]);

    expect(h.inserts).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(h.state.consentRows).toHaveLength(0);
  });

  it('grants only the on-consent members of a mixed scope set', async () => {
    await sync([READ, WRITE]);

    expect(h.state.consentRows).toHaveLength(1);
    expect(grantFor(WRITE)).toMatchObject({ status: 'active' });
    expect(grantFor(READ)).toBeUndefined();
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('syncConnectorConsentGrants — idempotent re-publish (#1647)', () => {
  it('does not duplicate a row when called twice with the same scopes', async () => {
    await sync([WRITE]);
    await sync([WRITE]);

    expect(grantsFor(WRITE)).toHaveLength(1);
    expect(h.state.consentRows).toHaveLength(1);
  });

  it('inserts once and converges via UPDATE on the second call', async () => {
    await sync([WRITE]);
    const insertsAfterFirst = h.inserts.length;

    await sync([WRITE]);

    expect(h.inserts).toHaveLength(insertsAfterFirst);
    expect(h.updates.at(-1)).toMatchObject({ status: 'active' });
  });

  it('reaches the same state after three consecutive publishes', async () => {
    await sync([WRITE]);
    await sync([WRITE]);
    await sync([WRITE]);

    expect(h.state.consentRows).toHaveLength(1);
    expect(grantFor(WRITE)).toMatchObject({ status: 'active', allowedFields: [WRITE] });
  });

  it('keeps the original row id across re-publishes', async () => {
    await sync([WRITE]);
    const firstId = grantFor(WRITE)?.id;

    await sync([WRITE]);

    expect(grantFor(WRITE)?.id).toBe(firstId);
  });
});

// ── Revoke path ───────────────────────────────────────────────────────────────

describe('syncConnectorConsentGrants — revokes scopes dropped from the manifest', () => {
  it('flips an active row to revoked when the scope is removed', async () => {
    seedGrant(WRITE, 'active');

    await sync([]);

    expect(grantFor(WRITE)).toMatchObject({ status: 'revoked' });
  });

  it('stamps updatedAt on the revocation', async () => {
    seedGrant(WRITE, 'active');

    await sync([]);

    expect(grantFor(WRITE)?.updatedAt).toBeInstanceOf(Date);
  });

  it('leaves an already-revoked row alone', async () => {
    seedGrant(WRITE, 'revoked');

    await sync([]);

    // The sweep only selects status='active' rows, so nothing is written.
    expect(h.updates).toHaveLength(0);
    expect(grantFor(WRITE)).toMatchObject({ status: 'revoked' });
  });

  it('does not revoke grants belonging to a different manifest asset', async () => {
    const foreign: Row = {
      id: 'cg_foreign',
      subject: OWNER,
      grantedTo: CONNECTOR_DID,
      purpose: 'document.projection',
      allowedFields: [WRITE],
      mode: 'attestation',
      status: 'active',
      consentRef: `asset_other:${WRITE}`,
    };
    h.state.consentRows.push(foreign);

    await sync([]);

    expect(foreign.status).toBe('active');
  });

  it('does not revoke grants belonging to a different connector', async () => {
    const other = seedGrant(WRITE, 'active');
    other.id = 'cg_other_connector';
    other.grantedTo = 'did:imajin:someone-else';

    await sync([]);

    expect(other.status).toBe('active');
  });
});

// ── Re-activation ─────────────────────────────────────────────────────────────

describe('syncConnectorConsentGrants — re-activates a revoked grant (#1647)', () => {
  it('flips a revoked row back to active instead of inserting a duplicate', async () => {
    const revoked = seedGrant(WRITE, 'revoked');

    await sync([WRITE]);

    expect(h.inserts).toHaveLength(0);
    expect(grantsFor(WRITE)).toHaveLength(1);
    expect(revoked.status).toBe('active');
  });

  it('reuses the original row id when re-activating', async () => {
    const revoked = seedGrant(WRITE, 'revoked');

    await sync([WRITE]);

    expect(grantFor(WRITE)?.id).toBe(revoked.id);
  });
});

// ── Full lifecycle ────────────────────────────────────────────────────────────

describe('syncConnectorConsentGrants — full grant → revoke → re-grant cycle (#1647)', () => {
  it('ends active after remove-then-re-add, with exactly one row throughout', async () => {
    // 1. Owner grants the scope.
    await sync([WRITE]);
    expect(grantFor(WRITE)).toMatchObject({ status: 'active' });

    // 2. Owner removes it from the manifest.
    await sync([]);
    expect(grantFor(WRITE)).toMatchObject({ status: 'revoked' });

    // 3. Owner re-publishes the manifest with the scope back.
    await sync([WRITE]);
    expect(grantFor(WRITE)).toMatchObject({ status: 'active' });

    // The regression: step 3 used to leave the row revoked (or stack a second
    // row), so the connector never regained the grant.
    expect(grantsFor(WRITE)).toHaveLength(1);
    expect(h.inserts).toHaveLength(1);
  });

  it('survives two full cycles without accumulating rows', async () => {
    await sync([WRITE]);
    await sync([]);
    await sync([WRITE]);
    await sync([]);
    await sync([WRITE]);

    expect(h.state.consentRows).toHaveLength(1);
    expect(grantFor(WRITE)).toMatchObject({ status: 'active' });
  });
});

// ── Mixed convergence ─────────────────────────────────────────────────────────

describe('syncConnectorConsentGrants — converges a mixed add/remove publish', () => {
  it('revokes the dropped scope and leaves the retained one active', async () => {
    await sync([WRITE, MESSAGES]);
    expect(grantFor(WRITE)).toMatchObject({ status: 'active' });
    expect(grantFor(MESSAGES)).toMatchObject({ status: 'active' });

    await sync([MESSAGES]);

    expect(grantFor(WRITE)).toMatchObject({ status: 'revoked' });
    expect(grantFor(MESSAGES)).toMatchObject({ status: 'active' });
  });

  it('adds a new scope and drops an old one in the same publish', async () => {
    await sync([WRITE]);

    await sync([MESSAGES]);

    expect(grantFor(WRITE)).toMatchObject({ status: 'revoked' });
    expect(grantFor(MESSAGES)).toMatchObject({ status: 'active' });
    expect(h.state.consentRows).toHaveLength(2);
  });

  it('gives each scope its own row', async () => {
    await sync([WRITE, MESSAGES]);

    expect(h.state.consentRows).toHaveLength(2);
    expect(grantFor(WRITE)?.id).not.toBe(grantFor(MESSAGES)?.id);
    expect(grantFor(WRITE)?.allowedFields).toEqual([WRITE]);
    expect(grantFor(MESSAGES)?.allowedFields).toEqual([MESSAGES]);
  });

  it('re-adding the dropped scope restores it without disturbing the other', async () => {
    await sync([WRITE, MESSAGES]);
    await sync([MESSAGES]);

    await sync([WRITE, MESSAGES]);

    expect(grantFor(WRITE)).toMatchObject({ status: 'active' });
    expect(grantFor(MESSAGES)).toMatchObject({ status: 'active' });
    expect(h.state.consentRows).toHaveLength(2);
  });
});

// ── consentRef keying ─────────────────────────────────────────────────────────

describe('syncConnectorConsentGrants — consentRef keying', () => {
  it('writes the ref that connectorConsentRef would build', async () => {
    await sync([WRITE]);

    expect(h.inserts[0].consentRef).toBe(connectorConsentRef(ASSET_ID, WRITE));
  });

  it('round-trips a scope name containing the separator', async () => {
    // `media:write` already carries a colon — the revoke sweep slices the ref
    // by the asset-id length, so a naive split(':') would mangle it.
    await sync([WRITE]);
    await sync([]);

    expect(grantFor(WRITE)).toMatchObject({ status: 'revoked' });
  });
});
