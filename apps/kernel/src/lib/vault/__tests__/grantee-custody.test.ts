/**
 * Grantee-aware custody: status and renewal (#1603).
 *
 * Static-secret custody (#1439) grants a field to a connector app DID rather than
 * to the node, and two node-only lookups did not account for that:
 *
 *   - `vaultFieldStatus` filtered on `grantedTo = nodeDid`, so it reported
 *     `pending-grant` for every static-secret field even when a valid grant
 *     existed. A connector card would render "waiting for owner approval" for a
 *     credential that works.
 *   - `listRenewableGrants` filtered the same way, so a static-secret grant never
 *     appeared on the owner agent's worklist and its expiry became a silent
 *     permanent lockout.
 *
 * Unlike the other vault doubles, the DB mock here evaluates the WHERE clause, so
 * the grantee distinction is genuinely exercised instead of assumed. That is the
 * whole point: a mock that ignores `grantedTo` cannot tell the bug from the fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';

type Row = Record<string, unknown>;

const { tmpVaultPath, grantStore, envelopeStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-grantee-custody-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return {
    tmpVaultPath,
    grantStore: new Map<string, Row>(),
    envelopeStore: new Map<string, Row>(),
  };
});

// ── Clause-evaluating drizzle double ─────────────────────────────────────────

type Clause =
  | { kind: 'and'; parts: Clause[] }
  | { kind: 'or'; parts: Clause[] }
  | { kind: 'eq'; col: string; value: unknown }
  | { kind: 'gt'; col: string; value: unknown }
  | { kind: 'isNull'; col: string };

vi.mock('drizzle-orm', () => ({
  and: (...parts: Clause[]) => ({ kind: 'and', parts: parts.filter(Boolean) }),
  or: (...parts: Clause[]) => ({ kind: 'or', parts: parts.filter(Boolean) }),
  eq: (col: string, value: unknown) => ({ kind: 'eq', col, value }),
  gt: (col: string, value: unknown) => ({ kind: 'gt', col, value }),
  isNull: (col: string) => ({ kind: 'isNull', col }),
  isNotNull: (col: string) => ({ kind: 'isNotNull', col }),
  lt: (col: string, value: unknown) => ({ kind: 'lt', col, value }),
  sql: (...args: unknown[]) => ({ kind: 'sql', args }),
}));

vi.mock('@/src/db', () => {
  const columns = (names: string[]) => Object.fromEntries(names.map((n) => [n, n]));

  const vaultDelegationGrants = columns([
    'id', 'subject', 'grantedTo', 'field', 'ownerXPub', 'wrappedKey', 'wrappedNonce',
    'keyId', 'ownerSignature', 'status', 'expiresAt', 'createdAt', 'revokedAt',
    'recipientXPub', 'ownerEdPub',
  ]);
  const vaultOwnerEnvelopes = columns([
    'id', 'field', 'keyId', 'ownerXPub', 'senderXPub', 'wrappedKey', 'wrappedNonce', 'createdAt',
  ]);
  const vaultGrantRequests = columns(['id', 'field', 'requestId', 'status', 'subject', 'grantedTo']);

  /** Which store a table object belongs to, by identity. */
  function storeFor(table: unknown): Map<string, Row> | undefined {
    if (table === vaultDelegationGrants) return grantStore;
    if (table === vaultOwnerEnvelopes) return envelopeStore;
    return undefined;
  }

  function matches(row: Row, clause: Clause | undefined): boolean {
    if (!clause) return true;
    switch (clause.kind) {
      case 'and':
        return clause.parts.every((p) => matches(row, p));
      case 'or':
        return clause.parts.some((p) => matches(row, p));
      case 'eq':
        return row[clause.col] === clause.value;
      case 'gt': {
        const left = row[clause.col];
        if (left instanceof Date && clause.value instanceof Date) {
          return left.getTime() > clause.value.getTime();
        }
        return false;
      }
      case 'isNull':
        return row[clause.col] === null || row[clause.col] === undefined;
      default:
        return true;
    }
  }

  function thenable<T extends object>(rows: () => Row[], extra: T) {
    const p = Promise.resolve(rows());
    return { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p), ...extra };
  }

  function envelopeKey(data: Row) {
    return `${String(data.field)}:${String(data.keyId)}`;
  }

  return {
    db: {
      insert: (table: unknown) => ({
        values: (data: Row) => {
          if (table === vaultOwnerEnvelopes) {
            envelopeStore.set(envelopeKey(data), data);
            return thenable(() => [], {
              onConflictDoUpdate: () => {
                envelopeStore.set(envelopeKey(data), data);
                return Promise.resolve([]);
              },
            });
          }
          const store = storeFor(table);
          if (store) store.set(String(data.id), data);
          return Promise.resolve([]);
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => ({
          where: (clause: Clause) => {
            const store = storeFor(table) ?? grantStore;
            const touched: Row[] = [];
            for (const [id, row] of store) {
              if (!matches(row, clause)) continue;
              const next = { ...row, ...patch };
              store.set(id, next);
              touched.push(next);
            }
            return thenable(() => [], { returning: () => Promise.resolve(touched) });
          },
        }),
      }),
      select: () => ({
        from: (table: unknown) => {
          const store = storeFor(table) ?? new Map<string, Row>();
          const all = () => [...store.values()];
          return thenable(all, {
            where: (clause: Clause) => {
              const filtered = () => all().filter((row) => matches(row, clause));
              return thenable(filtered, {
                limit: (n: number) => Promise.resolve(filtered().slice(0, n)),
              });
            },
          });
        },
      }),
      selectDistinct: () => ({
        from: (table: unknown) => ({
          where: (clause: Clause) => {
            const store = storeFor(table) ?? grantStore;
            const seen = new Set<string>();
            for (const row of store.values()) {
              if (matches(row, clause)) seen.add(String(row.grantedTo));
            }
            return Promise.resolve([...seen].map((grantedTo) => ({ grantedTo })));
          },
        }),
      }),
    },
    vaultDelegationGrants,
    vaultOwnerEnvelopes,
    vaultGrantRequests,
    channelLinks: columns(['channel', 'did', 'appDid', 'status', 'scopes']),
  };
});

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

import {
  sealAndGrantStaticSecret,
  listRenewableGrants,
  vaultFieldStatus,
  vaultFieldStatusForGrantee,
} from '../index.js';
import { getNodeSigningIdentity, _resetSealingCache } from '../sealing.js';

const PRINCIPAL = 'did:imajin:veteze';
const CONNECTOR = 'did:imajin:warp-connector';
const FIELD = `warp-agent-key:${PRINCIPAL}`;
const SECRET = 'warp-agent-key-SUPER-SECRET-VALUE';

function nodeDid(): string {
  return getNodeSigningIdentity().senderDid;
}

/** Move the connector's grant out of `active`, as expiry or revocation does. */
function lapseGrant(): void {
  for (const [id, row] of grantStore) {
    if (row.status === 'active') {
      grantStore.set(id, { ...row, status: 'expired', wrappedKey: '', wrappedNonce: '' });
    }
  }
}

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  _resetSealingCache();
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  await unlink(tmpVaultPath).catch(() => undefined);
});

// ── Status ────────────────────────────────────────────────────────────────────

describe('vaultFieldStatusForGrantee', () => {
  it('is ready for the grantee that actually holds the grant', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });

    expect(await vaultFieldStatusForGrantee(FIELD, CONNECTOR)).toBe('ready');
  });

  it('reports pending-grant for the NODE on the same field', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });

    // Not a bug in this function \u2014 the node genuinely holds no grant here. It is
    // why asking the node-scoped question about a static-secret field is wrong:
    // the honest answer is "not granted to you", which a card would have rendered
    // as "awaiting owner approval".
    expect(await vaultFieldStatus(FIELD)).toBe('pending-grant');
    expect(await vaultFieldStatusForGrantee(FIELD, nodeDid())).toBe('pending-grant');
  });

  it('is pending-grant for the grantee once its grant lapses', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });
    expect(await vaultFieldStatusForGrantee(FIELD, CONNECTOR)).toBe('ready');

    lapseGrant();

    expect(await vaultFieldStatusForGrantee(FIELD, CONNECTOR)).toBe('pending-grant');
  });

  it('is absent for a field that was never sealed', async () => {
    expect(await vaultFieldStatusForGrantee('never-seen', CONNECTOR)).toBe('absent');
  });

  it('isolates grantees: an unrelated DID never reads ready', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });

    expect(await vaultFieldStatusForGrantee(FIELD, 'did:imajin:someone-else')).toBe('pending-grant');
  });
});

// ── Renewal worklist ─────────────────────────────────────────────────────────

describe('listRenewableGrants with non-node grantees', () => {
  it('reports a lapsed static-secret grant, naming the grantee to re-issue to', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });
    lapseGrant();

    const renewable = await listRenewableGrants({ nodeDid: nodeDid() });
    const forConnector = renewable.find((g) => g.grantedTo === CONNECTOR);

    // Before #1603 this list was scanned as `grantedTo = nodeDid` only, so this
    // entry did not exist and the owner agent had nothing to renew.
    expect(forConnector).toBeDefined();
    expect(forConnector!.reason).toBe('missing');
    expect(forConnector!.field).toBe(FIELD);
  });

  it('leaves an active grant alone', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });

    const renewable = await listRenewableGrants({ nodeDid: nodeDid() });
    expect(renewable.find((g) => g.grantedTo === CONNECTOR)).toBeUndefined();
  });

  it('reports a grant lapsing inside the lookahead as expiring, for the right grantee', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
      expiresAt,
    });

    const renewable = await listRenewableGrants({
      nodeDid: nodeDid(),
      withinMs: 24 * 60 * 60 * 1000,
    });
    const forConnector = renewable.find((g) => g.grantedTo === CONNECTOR);

    expect(forConnector?.reason).toBe('expiring');
    expect(forConnector?.expiresAt).toBe(expiresAt.toISOString());
  });

  it('still reports the node itself when it holds no grant on a field', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });

    // The node is always considered, so a never-granted node is not silently
    // dropped just because some other grantee is healthy.
    const renewable = await listRenewableGrants({ nodeDid: nodeDid() });
    expect(renewable.find((g) => g.grantedTo === nodeDid())?.reason).toBe('missing');
  });

  it('carries envelope material the owner can actually open', async () => {
    await sealAndGrantStaticSecret(FIELD, SECRET, {
      principalDid: PRINCIPAL,
      granteeDid: CONNECTOR,
    });
    lapseGrant();

    const forConnector = (await listRenewableGrants({ nodeDid: nodeDid() })).find(
      (g) => g.grantedTo === CONNECTOR,
    )!;

    expect(forConnector.wrappedKey.length).toBeGreaterThan(0);
    expect(forConnector.wrappedNonce.length).toBeGreaterThan(0);
    expect(forConnector.ownerXPub.length).toBeGreaterThan(0);
    expect(forConnector.senderXPub.length).toBeGreaterThan(0);
  });
});
