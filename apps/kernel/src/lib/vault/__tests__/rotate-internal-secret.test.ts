/**
 * Rotating an `internal-secret:*` field must keep its purpose (#2446).
 *
 * Prod, 2026-09-29: an operator rotated
 * `internal-secret:kernel.attestation-internal-api-key` from /admin/vault.
 * `rotateAndStore` → `sealAndStoreV2` superseded the purpose-tagged grant and
 * minted its replacement with `purpose = NULL`. The kernel resolves internal
 * secrets BY PURPOSE, so on its next restart the lookup missed, the claim
 * insert collided with the existing `internal_secret_provisions` row, and every
 * request polled ~500ms and gave up — `verify-email/confirm` (vault-only)
 * redirected `?verified=error`.
 *
 * These tests run the REAL vault crypto (index.ts / internal-secret.ts) over a
 * stateful in-memory DB double, and model a kernel restart as
 * `vi.resetModules()` + a fresh import: every module-level cache is gone, only
 * the DB stores and the vault file survive — exactly what a process restart
 * keeps. No fixture secrets: every key/value is generated per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
type Handler = (event: { type: string; payload: Row }) => Promise<void> | void;

const { tmpVaultPath, stores, logSpies, reactors } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-rotate-internal-secret-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;
  process.env.VAULT_ALLOW_BOOTSTRAP = '1';

  return {
    tmpVaultPath,
    stores: {
      grants: new Map<string, Record<string, unknown>>(),
      envelopes: new Map<string, Record<string, unknown>>(),
      requests: new Map<string, Record<string, unknown>>(),
      provisions: new Map<string, Record<string, unknown>>(),
    },
    logSpies: { warn: vi.fn(), error: vi.fn() },
    reactors: new Map<string, (event: { type: string; payload: Record<string, unknown> }) => unknown>(),
  };
});

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const isNull = (column: string): Predicate => (row) => row[column] === null || row[column] === undefined;
  const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
  const gt = (column: string, value: unknown): Predicate => (row) =>
    row[column] !== null && row[column] !== undefined && toMs(row[column]) > toMs(value);
  const lt = (column: string, value: unknown): Predicate => (row) =>
    row[column] !== null && row[column] !== undefined && toMs(row[column]) < toMs(value);
  const and = (...preds: Array<Predicate | undefined>): Predicate => (row) => preds.every((p) => !p || p(row));
  const or = (...preds: Predicate[]): Predicate => (row) => preds.some((p) => p(row));
  const like = (column: string, pattern: string): Predicate => (row) =>
    String(row[column]).startsWith(pattern.replaceAll('%', ''));
  const desc = (column: string) => ({ column, direction: 'desc' });
  return { ...actual, eq, and, or, isNull, gt, lt, like, desc };
});

// ── DB double ────────────────────────────────────────────────────────────────
// Helpers are top-level function declarations (hoisted, so the hoisted
// vi.mock factory below can reference them) purely to stay inside the
// linter's nested-function depth budget.

function columns(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, name]));
}

function storeFor(table: { __table?: string }): Map<string, Row> {
  return stores[(table.__table ?? 'grants') as keyof typeof stores];
}

/** Natural keys for the tables with a real unique constraint, so the double refuses what Postgres would. */
function keyFor(table: { __table?: string }, data: Row): string {
  if (table.__table === 'envelopes') return `${String(data.field)}:${String(data.keyId)}`;
  if (table.__table === 'provisions') return `${String(data.ownerDid)}::${String(data.purpose)}`;
  return String(data.id);
}

function sameActiveTuple(a: Row, b: Row): boolean {
  return a.status === 'active' && a.subject === b.subject && a.grantedTo === b.grantedTo
    && a.field === b.field && a.keyId === b.keyId;
}

/** `uniq_vault_delegation_active` over (subject, grantedTo, field, keyId) WHERE status = 'active'. */
function assertActiveGrantUnique(data: Row): void {
  if (data.status !== 'active') return;
  if ([...stores.grants.values()].some((row) => sameActiveTuple(row, data))) {
    throw Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'uniq_vault_delegation_active' });
  }
}

function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  return rows.map((row) => Object.fromEntries(Object.entries(projection).map(([k, col]) => [k, row[col]])));
}

function byColumnDesc(column: string): (a: Row, b: Row) => number {
  return (a, b) => Number(b[column]) - Number(a[column]);
}

function memoize(fn: () => Row[]): () => Row[] {
  let memo: Row[] | undefined;
  return () => (memo ??= fn());
}

/** A lazily-executed drizzle-ish query: awaitable, with .limit() and .orderBy(). */
function queryable(rows: () => Row[]) {
  const run = () => Promise.resolve().then(rows);
  return {
    then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
    catch: (rej: (e: unknown) => unknown) => run().catch(rej),
    limit: (n: number) => run().then((r) => r.slice(0, n)),
    orderBy: (order: { column: string }) => queryable(() => [...rows()].sort(byColumnDesc(order.column))),
  };
}

function writeRow(table: { __table?: string }, data: Row): Row[] {
  if (table.__table === 'grants') assertActiveGrantUnique(data);
  storeFor(table).set(keyFor(table, data), data);
  return [data];
}

function upsertRow(table: { __table?: string }, data: Row, set: Row | undefined): Row[] {
  const store = storeFor(table);
  const key = keyFor(table, data);
  const existing = store.get(key);
  store.set(key, existing ? { ...existing, ...(set ?? data) } : data);
  return [];
}

function insertValues(table: { __table?: string }, raw: Row) {
  const data: Row = { createdAt: new Date(), ...raw };
  if (table.__table === 'grants') {
    data.oneTime ??= false;
    data.consumedAt ??= null; // Postgres column default — fetchGrantSecret checks `!== null`
  }
  const exists = () => storeFor(table).has(keyFor(table, data));
  // Envelopes are always written through onConflictDoUpdate in the code under test.
  const plain = (): Row[] => {
    if (table.__table === 'envelopes') return upsertRow(table, data, data);
    return writeRow(table, data);
  };
  return {
    ...queryable(plain),
    onConflictDoNothing: () => ({
      returning: (projection?: Record<string, string>) =>
        Promise.resolve(exists() ? [] : project(writeRow(table, data), projection)),
    }),
    onConflictDoUpdate: (opts: { set?: Row }) => Promise.resolve(upsertRow(table, data, opts.set)),
  };
}

function patchMatching(table: { __table?: string }, patch: Row, predicate: Predicate): Row[] {
  const store = storeFor(table);
  const out: Row[] = [];
  for (const [id, row] of store) {
    if (predicate(row)) {
      const next = { ...row, ...patch };
      store.set(id, next);
      out.push(next);
    }
  }
  return out;
}

function deleteMatching(table: { __table?: string }, predicate: Predicate): Row[] {
  const store = storeFor(table);
  const out: Row[] = [];
  for (const [id, row] of store) {
    if (predicate(row)) {
      store.delete(id);
      out.push(row);
    }
  }
  return out;
}

/** An awaitable mutation that also supports .returning(), executing exactly once either way. */
function mutation(execute: () => Row[]) {
  const once = memoize(execute);
  const awaited = (): Row[] => {
    once();
    return [];
  };
  return {
    ...queryable(awaited),
    returning: (projection?: Record<string, string>) => Promise.resolve(project(once(), projection)),
  };
}

const dbDouble = {
  insert: (table: { __table?: string }) => ({ values: (raw: Row) => insertValues(table, raw) }),
  update: (table: { __table?: string }) => ({
    set: (patch: Row) => ({ where: (predicate: Predicate) => mutation(() => patchMatching(table, patch, predicate)) }),
  }),
  delete: (table: { __table?: string }) => ({
    where: (predicate: Predicate) => mutation(() => deleteMatching(table, predicate)),
  }),
  select: (projection?: Record<string, string>) => ({
    from: (table: { __table?: string }) => ({
      where: (predicate: Predicate) => queryable(() => project([...storeFor(table).values()].filter(predicate), projection)),
    }),
  }),
};

vi.mock('@/src/db', () => ({
  db: dbDouble,
  vaultDelegationGrants: {
    __table: 'grants',
    ...columns([
      'id', 'subject', 'grantedTo', 'field', 'ownerXPub', 'wrappedKey', 'wrappedNonce', 'keyId',
      'ownerSignature', 'status', 'expiresAt', 'createdAt', 'revokedAt', 'recipientXPub', 'ownerEdPub',
      'purpose', 'oneTime', 'consumedAt', 'lastFetchedAt', 'ackedAt', 'ackOutcome',
    ]),
  },
  vaultOwnerEnvelopes: {
    __table: 'envelopes',
    ...columns(['id', 'field', 'keyId', 'ownerXPub', 'senderXPub', 'wrappedKey', 'wrappedNonce', 'createdAt']),
  },
  vaultGrantRequests: {
    __table: 'requests',
    ...columns(['id', 'field', 'keyId', 'requestId', 'status', 'createdAt', 'expiresAt', 'grantId']),
  },
  internalSecretProvisions: {
    __table: 'provisions',
    ...columns(['id', 'ownerDid', 'purpose', 'field', 'grantId', 'createdAt']),
  },
  channelLinks: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

// In-process bus: reactors registered by the code under test really run on
// publish, so the vault hot-reload wiring (#2446 fix 3) is exercised end to end.
vi.mock('@imajin/bus', () => ({
  registerReactor: (type: string, handler: Handler) => reactors.set(type, handler as never),
  publish: vi.fn(async (type: string, event: { payload: Row }) => {
    if (type === 'vault.secret.rotated' || type === 'vault.secret.updated') {
      await reactors.get('vault-hot-reload')?.({ type, payload: event.payload });
    }
  }),
}));

vi.mock('@imajin/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/auth')>();
  return { ...actual, emitAttestation: vi.fn().mockResolvedValue(undefined), requireAdmin: vi.fn().mockResolvedValue(true) };
});

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: logSpies.warn, error: logSpies.error }),
}));

vi.mock('@imajin/db', () => ({ getClient: () => () => Promise.resolve([]) }));

const PURPOSE = 'kernel.attestation-internal-api-key';
const FIELD = `internal-secret:${PURPOSE}`;

/** A fresh kernel process: every module-level cache gone, DB + vault file kept. */
async function boot() {
  vi.resetModules();
  const vault = await import('../index.js');
  const internal = await import('../internal-secret.js');
  const sealing = await import('../sealing.js');
  return { vault, internal, sealing };
}

function activeGrantsFor(field: string): Row[] {
  return [...stores.grants.values()].filter((g) => g.field === field && g.status === 'active');
}

async function rotateViaRoute(field: string, value: string): Promise<Response> {
  const { POST } = await import('@/app/api/vault/rotate/route');
  const { NextRequest } = await import('next/server');
  return POST(new NextRequest('http://kernel.test/api/vault/rotate', {
    method: 'POST',
    body: JSON.stringify({ field, value }),
  }));
}

beforeEach(() => {
  for (const store of Object.values(stores)) store.clear();
  reactors.clear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
  delete process.env.ATTESTATION_INTERNAL_API_KEY; // vault-only: no env fallback to hide a miss
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.AUTH_PRIVATE_KEY;
  await unlink(tmpVaultPath).catch(() => undefined);
});

describe('rotate an internal-secret:* field (#2446)', () => {
  it('the active grant keeps its purpose after rotate', async () => {
    const { internal } = await boot();
    await internal.getInternalSecret(PURPOSE);

    const res = await rotateViaRoute(FIELD, randomBytes(24).toString('hex'));
    expect(res.status).toBe(200);

    const active = activeGrantsFor(FIELD);
    expect(active).toHaveLength(1);
    expect(active[0]!.purpose).toBe(PURPOSE);
  });

  it('provisions row points at the rotated grant', async () => {
    const { internal } = await boot();
    await internal.getInternalSecret(PURPOSE);

    await rotateViaRoute(FIELD, randomBytes(24).toString('hex'));

    const [active] = activeGrantsFor(FIELD);
    const [provision] = [...stores.provisions.values()];
    expect(provision!.grantId).toBe(active!.id);
  });

  it('rotate → restart → resolve by purpose returns the rotated value, no errors', async () => {
    const first = await boot();
    const original = await first.internal.getInternalSecret(PURPOSE);
    const rotated = randomBytes(24).toString('hex');
    await rotateViaRoute(FIELD, rotated);

    const restarted = await boot();
    await expect(restarted.internal.getInternalSecret(PURPOSE)).resolves.toBe(rotated);
    expect(rotated).not.toBe(original);
    expect(logSpies.error).not.toHaveBeenCalled();
  });

  it('a running process picks up the rotated value without a restart', async () => {
    const { internal } = await boot();
    await internal.getInternalSecret(PURPOSE);
    const rotated = randomBytes(24).toString('hex');

    await rotateViaRoute(FIELD, rotated);

    await expect(internal.getInternalSecret(PURPOSE)).resolves.toBe(rotated);
  });

  it('the vault.secret.rotated event alone invalidates the cached value (subscribeToSecret wiring)', async () => {
    const { internal, sealing } = await boot();
    await internal.getInternalSecret(PURPOSE);
    const ownerDid = sealing.getNodeSigningIdentity().senderDid;
    const replaced = randomBytes(24).toString('hex');
    // Re-seal WITHOUT the rotate path's direct invalidation — only the bus event can refresh the cache.
    await internal.sealAndRecordInternalSecret(ownerDid, PURPOSE, replaced);
    const bus = await import('@imajin/bus');

    await bus.publish('vault.secret.rotated', {
      issuer: ownerDid, subject: ownerDid, scope: 'vault', payload: { field: FIELD } as never,
    });

    await expect(internal.getInternalSecret(PURPOSE)).resolves.toBe(replaced);
  });

  it('a plain v2 field keeps its grant purpose across rotate (general path)', async () => {
    const { vault, sealing } = await boot();
    const nodeDid = sealing.getNodeSigningIdentity().senderDid;
    const field = 'agent-handoff:example';
    await vault.sealAndGrantStaticSecret(field, 'v1-value', {
      principalDid: nodeDid, granteeDid: nodeDid, purpose: 'agent.example-handoff',
    });

    await vault.rotateAndStore(field, 'v2-value');

    const active = activeGrantsFor(field);
    expect(active).toHaveLength(1);
    expect(active[0]!.purpose).toBe('agent.example-handoff');
    expect(await vault.loadAndUnseal(field)).toBe('v2-value');
  });

  it('external grantees of a shared internal secret are re-issued on the new key', async () => {
    const { vault, internal } = await boot();
    await internal.getInternalSecret(PURPOSE);
    const corpusDid = 'did:imajin:corpus-test';
    const granted = await vault.grantInternalSecretTo(PURPOSE, corpusDid, 'test-operator');
    expect(granted.status).toBe('ok');
    const rotated = randomBytes(24).toString('hex');

    await rotateViaRoute(FIELD, rotated);

    const external = activeGrantsFor(FIELD).filter((g) => g.grantedTo === corpusDid);
    expect(external).toHaveLength(1);
    expect(external[0]!.purpose).toBe(PURPOSE);
    const fetched = await vault.fetchGrantSecret({ grantId: String(external[0]!.id), granteeDid: corpusDid });
    expect(fetched).toMatchObject({ status: 'ok', value: rotated });
  });

  it('re-issue carries each grantee\'s own terms forward and never widens (expired / consumed are dropped)', async () => {
    const { vault, internal } = await boot();
    await internal.getInternalSecret(PURPOSE);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const setTerms = async (did: string, terms: Row) => {
      const res = await vault.grantInternalSecretTo(PURPOSE, did, 'test-operator');
      const id = res.status === 'ok' ? res.grantId : '';
      stores.grants.set(id, { ...stores.grants.get(id)!, ...terms });
    };
    await setTerms('did:imajin:scoped', { expiresAt: future, oneTime: true, purpose: 'corpus.custom' });
    await setTerms('did:imajin:expired', { expiresAt: new Date(Date.now() - 1000) });
    await setTerms('did:imajin:consumed', { oneTime: true, consumedAt: new Date() });
    const rotated = randomBytes(24).toString('hex');

    const res = await rotateViaRoute(FIELD, rotated);
    expect(res.status).toBe(200);

    const byGrantee = (did: string) => activeGrantsFor(FIELD).filter((g) => g.grantedTo === did);
    const [scoped] = byGrantee('did:imajin:scoped');
    expect(scoped).toMatchObject({ expiresAt: future, oneTime: true, purpose: 'corpus.custom' });
    // Signed with the carried-forward expiry: the grant verifies and decrypts the new value.
    const fetched = await vault.fetchGrantSecret({ grantId: String(scoped!.id), granteeDid: 'did:imajin:scoped' });
    expect(fetched).toMatchObject({ status: 'ok', value: rotated });
    expect(byGrantee('did:imajin:expired')).toHaveLength(0);
    expect(byGrantee('did:imajin:consumed')).toHaveLength(0);
  });

  it('Tier 1: rotate of an internal secret is refused before anything is written', async () => {
    const first = await boot();
    await first.internal.getInternalSecret(PURPOSE);
    const before = {
      grants: JSON.stringify([...stores.grants.values()]),
      provisions: JSON.stringify([...stores.provisions.values()]),
      cid: (await first.vault.vaultService.peek(FIELD))?.cid,
    };
    process.env.VAULT_OWNER_X_PUB = randomBytes(32).toString('hex');
    process.env.VAULT_OWNER_ED_PUB = randomBytes(32).toString('hex');

    const tier1 = await boot();
    const res = await rotateViaRoute(FIELD, randomBytes(24).toString('hex'));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify([...stores.grants.values()])).toBe(before.grants);
    expect(JSON.stringify([...stores.provisions.values()])).toBe(before.provisions);
    expect((await tier1.vault.vaultService.peek(FIELD))?.cid).toBe(before.cid);
    expect(stores.requests.size).toBe(0);
  });
});

/**
 * The state a pre-#2446 rotation leaves behind: the active self-grant lost
 * its purpose (no re-seal — the value and key are what the operator set).
 * `deleteRow` additionally mirrors prod's 2026-09-29 manual recovery.
 */
function stripPurpose(options: { deleteRow: boolean }): void {
  for (const g of activeGrantsFor(FIELD)) {
    if (g.grantedTo === g.subject) stores.grants.set(String(g.id), { ...g, purpose: null });
  }
  if (options.deleteRow) stores.provisions.clear();
}

describe('kernel bootstrap without a purpose-tagged grant (#2446 ruling a: re-tag in place)', () => {
  it('prod\'s exact state (row deleted, field readable): value kept, no new secret, no re-seal, one WARN', async () => {
    const first = await boot();
    await first.internal.getInternalSecret(PURPOSE);
    const rotated = randomBytes(24).toString('hex');
    await rotateViaRoute(FIELD, rotated);
    stripPurpose({ deleteRow: true });
    const [selfGrant] = activeGrantsFor(FIELD);
    const cidBefore = (await first.vault.vaultService.peek(FIELD))?.cid;
    logSpies.warn.mockClear();

    const restarted = await boot();
    await expect(restarted.internal.getInternalSecret(PURPOSE)).resolves.toBe(rotated);
    await restarted.internal.getInternalSecret(PURPOSE);

    const active = activeGrantsFor(FIELD);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(selfGrant!.id); // same grant, re-tagged
    expect(active[0]!.purpose).toBe(PURPOSE);
    expect((await restarted.vault.vaultService.peek(FIELD))?.cid).toBe(cidBefore); // no re-seal
    expect([...stores.provisions.values()][0]!.grantId).toBe(selfGrant!.id);
    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
  });

  it('stranded row (recorded grant, purpose lost): re-tags instead of polling and giving up', async () => {
    const first = await boot();
    await first.internal.getInternalSecret(PURPOSE);
    const rotated = randomBytes(24).toString('hex');
    await rotateViaRoute(FIELD, rotated);
    stripPurpose({ deleteRow: false });
    logSpies.warn.mockClear();

    const restarted = await boot();
    await expect(restarted.internal.getInternalSecret(PURPOSE)).resolves.toBe(rotated);

    const active = activeGrantsFor(FIELD);
    expect(active).toHaveLength(1);
    expect(active[0]!.purpose).toBe(PURPOSE);
    expect([...stores.provisions.values()][0]!.grantId).toBe(active[0]!.id);
    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
  });

  it('a healthy external grantee keeps working across the repair (same value, grant untouched)', async () => {
    const first = await boot();
    const value = await first.internal.getInternalSecret(PURPOSE);
    const corpusDid = 'did:imajin:corpus-test';
    const granted = await first.vault.grantInternalSecretTo(PURPOSE, corpusDid, 'test-operator');
    const corpusGrantId = granted.status === 'ok' ? granted.grantId : '';
    stripPurpose({ deleteRow: true });

    const restarted = await boot();
    await expect(restarted.internal.getInternalSecret(PURPOSE)).resolves.toBe(value);

    expect(stores.grants.get(corpusGrantId)?.status).toBe('active');
    const fetched = await restarted.vault.fetchGrantSecret({ grantId: corpusGrantId, granteeDid: corpusDid });
    expect(fetched).toMatchObject({ status: 'ok', value });
  });

  it('re-tag race: two processes booting at once resolve the same value, one grant, no re-seal', async () => {
    const first = await boot();
    await first.internal.getInternalSecret(PURPOSE);
    const rotated = randomBytes(24).toString('hex');
    await rotateViaRoute(FIELD, rotated);
    stripPurpose({ deleteRow: true });
    const [selfGrant] = activeGrantsFor(FIELD);
    const cidBefore = (await first.vault.vaultService.peek(FIELD))?.cid;

    const a = await boot();
    const b = await boot();
    const values = await Promise.all([a.internal.getInternalSecret(PURPOSE), b.internal.getInternalSecret(PURPOSE)]);

    expect(values).toEqual([rotated, rotated]);
    const active = activeGrantsFor(FIELD);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(selfGrant!.id);
    expect(active[0]!.purpose).toBe(PURPOSE);
    expect((await b.vault.vaultService.peek(FIELD))?.cid).toBe(cidBefore);
    expect(stores.provisions.size).toBe(1);
  });

  it('tampered grant: the error surfaces on every call, the entry is never replaced, the row survives', async () => {
    const first = await boot();
    await first.internal.getInternalSecret(PURPOSE);
    stripPurpose({ deleteRow: true });
    const [selfGrant] = activeGrantsFor(FIELD);
    stores.grants.set(String(selfGrant!.id), { ...selfGrant!, ownerSignature: randomBytes(64).toString('hex') });
    const cidBefore = (await first.vault.vaultService.peek(FIELD))?.cid;
    const grantsBefore = stores.grants.size;

    const restarted = await boot();
    await expect(restarted.internal.getInternalSecret(PURPOSE)).rejects.toThrow();
    await expect(restarted.internal.getInternalSecret(PURPOSE)).rejects.toThrow();

    expect((await restarted.vault.vaultService.peek(FIELD))?.cid).toBe(cidBefore);
    expect(stores.grants.size).toBe(grantsBefore);
    expect(stores.provisions.size).toBe(1);
  });

  it('nothing readable left: generates fresh and ERRORs naming the grantees now on a dead key', async () => {
    const first = await boot();
    const original = await first.internal.getInternalSecret(PURPOSE);
    const corpusDid = 'did:imajin:corpus-test';
    await first.vault.grantInternalSecretTo(PURPOSE, corpusDid, 'test-operator');
    for (const g of activeGrantsFor(FIELD)) {
      if (g.grantedTo === g.subject) stores.grants.set(String(g.id), { ...g, status: 'revoked' });
    }

    const restarted = await boot();
    const fresh = await restarted.internal.getInternalSecret(PURPOSE);

    expect(fresh).not.toBe(original);
    expect(logSpies.error).toHaveBeenCalledWith(
      expect.objectContaining({ staleGrantees: [corpusDid] }),
      expect.stringMatching(/re-granted by an operator/),
    );
  });

  it('a crashed winner\'s stale claim (no grant ever recorded) is re-claimed and generated', async () => {
    const { sealing } = await boot();
    const ownerDid = sealing.getNodeSigningIdentity().senderDid;
    stores.provisions.set(`${ownerDid}::${PURPOSE}`, {
      id: 'isp_stale', ownerDid, purpose: PURPOSE, field: FIELD, grantId: null,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const restarted = await boot();
    const value = await restarted.internal.getInternalSecret(PURPOSE);

    expect(value).toMatch(/^[0-9a-f]{64}$/);
    const [active] = activeGrantsFor(FIELD);
    expect(active!.purpose).toBe(PURPOSE);
    expect([...stores.provisions.values()][0]!.grantId).toBe(active!.id);
  });
});

describe('verify-email confirm across rotate + restart (#2446)', () => {
  it('still issues email_verified with the vault-sourced key', async () => {
    const first = await boot();
    await first.internal.getInternalSecret(PURPOSE);
    await rotateViaRoute(FIELD, randomBytes(24).toString('hex'));

    const restarted = await boot();
    const did = 'did:imajin:verify-test';
    const nonce = randomBytes(8).toString('hex');
    const exp = Date.now() + 60_000;
    await restarted.vault.sealAndStore(`verify:email-nonce:${did}`, `${nonce}:${exp}`);
    await restarted.vault.sealAndStore(`contact:email:${did}`, 'someone@example.test');
    const tok = createHmac('sha256', String(process.env.AUTH_PRIVATE_KEY))
      .update(`${did}:${nonce}:${exp}`)
      .digest('base64url');

    // The internal attestation endpoint is the kernel's own requireInternalApiKey.
    const { requireInternalApiKey } = await import('@/src/lib/auth/require-internal-api-key');
    const { NextRequest } = await import('next/server');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const denied = await requireInternalApiKey(new NextRequest(url, init as never));
      return denied ?? new Response('{}', { status: 201 });
    }));

    const { GET } = await import('@/app/profile/api/contact/verify-email/confirm/route');
    const qs = new URLSearchParams({ did, nonce, exp: String(exp), tok });
    const res = await GET(new NextRequest(`http://kernel.test/profile/api/contact/verify-email/confirm?${qs}`));

    expect(res.headers.get('location')).toMatch(/verified=email$/);
  });
});
