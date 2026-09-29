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

function columns(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, name]));
}

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = {
    __table: 'grants',
    ...columns([
      'id', 'subject', 'grantedTo', 'field', 'ownerXPub', 'wrappedKey', 'wrappedNonce', 'keyId',
      'ownerSignature', 'status', 'expiresAt', 'createdAt', 'revokedAt', 'recipientXPub', 'ownerEdPub',
      'purpose', 'oneTime', 'consumedAt', 'lastFetchedAt', 'ackedAt', 'ackOutcome',
    ]),
  };
  const vaultOwnerEnvelopes = {
    __table: 'envelopes',
    ...columns(['id', 'field', 'keyId', 'ownerXPub', 'senderXPub', 'wrappedKey', 'wrappedNonce', 'createdAt']),
  };
  const vaultGrantRequests = {
    __table: 'requests',
    ...columns(['id', 'field', 'keyId', 'requestId', 'status', 'createdAt', 'expiresAt', 'grantId']),
  };
  const internalSecretProvisions = {
    __table: 'provisions',
    ...columns(['id', 'ownerDid', 'purpose', 'field', 'grantId', 'createdAt']),
  };

  const storeFor = (table: { __table?: string }): Map<string, Row> =>
    stores[(table.__table ?? 'grants') as keyof typeof stores];

  // Natural keys for the three tables with a real unique constraint, so the
  // double refuses exactly what Postgres would.
  const keyFor = (table: { __table?: string }, data: Row): string => {
    if (table.__table === 'envelopes') return `${String(data.field)}:${String(data.keyId)}`;
    if (table.__table === 'provisions') return `${String(data.ownerDid)}::${String(data.purpose)}`;
    return String(data.id);
  };

  function assertActiveGrantUnique(data: Row): void {
    if (data.status !== 'active') return;
    for (const row of stores.grants.values()) {
      if (
        row.status === 'active' && row.subject === data.subject && row.grantedTo === data.grantedTo
        && row.field === data.field && row.keyId === data.keyId
      ) {
        throw Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'uniq_vault_delegation_active' });
      }
    }
  }

  function project(rows: Row[], projection?: Record<string, string>): Row[] {
    if (!projection) return rows;
    return rows.map((row) => Object.fromEntries(Object.entries(projection).map(([k, col]) => [k, row[col]])));
  }

  function queryable(rows: () => Row[]) {
    const run = () => Promise.resolve().then(rows);
    return {
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => run().catch(rej),
      limit: (n: number) => run().then((r) => r.slice(0, n)),
      orderBy: (order: { column: string }) =>
        queryable(() => [...rows()].sort((a, b) => Number(b[order.column]) - Number(a[order.column]))),
    };
  }

  const insert = (table: { __table?: string }) => ({
    values: (raw: Row) => {
      const store = storeFor(table);
      const data: Row = { createdAt: new Date(), ...raw };
      if (table.__table === 'grants') data.oneTime ??= false;
      const key = keyFor(table, data);
      const write = () => {
        if (table.__table === 'grants') assertActiveGrantUnique(data);
        store.set(key, data);
        return [data];
      };
      return {
        ...queryable(() => (table.__table === 'envelopes' ? (store.set(key, data), []) : write())),
        onConflictDoNothing: () => ({
          returning: (projection?: Record<string, string>) =>
            Promise.resolve(store.has(key) ? [] : project(write(), projection)),
        }),
        onConflictDoUpdate: (opts: { set?: Row }) => {
          const existing = store.get(key);
          store.set(key, existing ? { ...existing, ...(opts.set ?? data) } : data);
          return Promise.resolve([]);
        },
      };
    },
  });

  const update = (table: { __table?: string }) => ({
    set: (patch: Row) => ({
      where: (predicate: Predicate) => {
        const touched = () => {
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
        };
        let memo: Row[] | undefined;
        const once = () => (memo ??= touched());
        return {
          ...queryable(() => (once(), [])),
          returning: (projection?: Record<string, string>) => Promise.resolve(project(once(), projection)),
        };
      },
    }),
  });

  const del = (table: { __table?: string }) => ({
    where: (predicate: Predicate) => {
      let memo: Row[] | undefined;
      const once = () => {
        if (memo) return memo;
        const store = storeFor(table);
        memo = [];
        for (const [id, row] of store) {
          if (predicate(row)) {
            store.delete(id);
            memo.push(row);
          }
        }
        return memo;
      };
      return {
        ...queryable(() => (once(), [])),
        returning: (projection?: Record<string, string>) => Promise.resolve(project(once(), projection)),
      };
    },
  });

  return {
    db: {
      insert,
      update,
      delete: del,
      select: (projection?: Record<string, string>) => ({
        from: (table: { __table?: string }) => ({
          where: (predicate: Predicate) =>
            queryable(() => project([...storeFor(table).values()].filter(predicate), projection)),
        }),
      }),
    },
    vaultDelegationGrants,
    vaultOwnerEnvelopes,
    vaultGrantRequests,
    internalSecretProvisions,
    channelLinks: {},
  };
});

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
});

describe('kernel bootstrap with a stranded provisions row (#2446)', () => {
  it('re-provisions (adopting the current value) instead of polling and giving up — one WARN', async () => {
    const first = await boot();
    await first.internal.getInternalSecret(PURPOSE);
    const rotated = randomBytes(24).toString('hex');
    await rotateViaRoute(FIELD, rotated);
    // Reproduce the pre-fix prod state exactly: the rotated grant lost its purpose.
    for (const g of activeGrantsFor(FIELD)) stores.grants.set(String(g.id), { ...g, purpose: null });

    const restarted = await boot();
    await expect(restarted.internal.getInternalSecret(PURPOSE)).resolves.toBe(rotated);
    await restarted.internal.getInternalSecret(PURPOSE);
    await restarted.internal.getInternalSecret(PURPOSE);

    const active = activeGrantsFor(FIELD);
    expect(active).toHaveLength(1);
    expect(active[0]!.purpose).toBe(PURPOSE);
    expect([...stores.provisions.values()][0]!.grantId).toBe(active[0]!.id);
    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
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
