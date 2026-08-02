/**
 * rotateAndStore must preserve custody scheme across a rotation (#1546).
 *
 * Before this fix, EVERY rotation hardcoded v1 via prepareRotationEntry,
 * regardless of the existing entry's version. A v2 (delegation-grant) field
 * kept reading fine after rotation — via the node's static seal key — so
 * nothing broke visibly. The field just silently exited delegation-grant
 * custody, and the stale vault_delegation_grants row was left dangling,
 * active, and unusable. These tests pin that a rotation is "re-seal, keep
 * the chain" for a v2 field, not a downgrade.
 *
 * The DB is a stateful in-memory double using real predicate builders for
 * eq/and/or/isNull/gt (mirroring migrate-custody.test.ts), so grant/envelope
 * lookups are correctly scoped by field/keyId/status rather than the
 * "just return the only active row" shortcut older single-field tests use.
 * VAULT_PATH is redirected via vi.hoisted() so the module-level vault
 * singleton uses an isolated file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { deriveXKeypairFromEd25519, unwrapFieldKey } from '@imajin/vault-core';

type Row = Record<string, unknown>;

const { tmpVaultPath, grantStore, envelopeStore, requestStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-rotate-custody-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return {
    tmpVaultPath,
    grantStore: new Map<string, Row>(),
    envelopeStore: new Map<string, Row>(),
    requestStore: new Map<string, Row>(),
  };
});

type Predicate = (row: Row) => boolean;

// Real column-based filtering rather than the single-field "just return the
// only active row" shortcut: rotation tests keep BOTH the superseded and the
// new active grant for the same field in the store simultaneously, so a
// query that ignores its own WHERE clause could pass by accident.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const isNull = (column: string): Predicate => (row) => row[column] === null || row[column] === undefined;
  const gt = (column: string, value: unknown): Predicate => (row) => {
    const rowValue = row[column] as Date | number | null | undefined;
    if (rowValue === null || rowValue === undefined) return false;
    const a = rowValue instanceof Date ? rowValue.getTime() : rowValue;
    const b = value instanceof Date ? value.getTime() : (value as number);
    return a > b;
  };
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  const or = (...preds: Predicate[]): Predicate => (row) => preds.some((p) => p(row));
  return { ...actual, eq, and, or, isNull, gt };
});

function columns(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, name]));
}

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = {
    __table: 'grants',
    ...columns([
      'id', 'subject', 'grantedTo', 'field', 'ownerXPub', 'wrappedKey', 'wrappedNonce',
      'keyId', 'ownerSignature', 'status', 'expiresAt', 'createdAt', 'revokedAt',
      'recipientXPub', 'ownerEdPub',
    ]),
  };
  const vaultOwnerEnvelopes = {
    __table: 'envelopes',
    ...columns(['id', 'field', 'keyId', 'ownerXPub', 'senderXPub', 'wrappedKey', 'wrappedNonce', 'createdAt']),
  };
  const vaultGrantRequests = {
    __table: 'requests',
    ...columns([
      'id', 'field', 'keyId', 'requestId', 'nodeXPub', 'ownerXPub', 'wrappedFieldKey',
      'wrappedFieldKeyNonce', 'status', 'createdAt', 'expiresAt', 'fulfilledAt', 'grantId',
    ]),
  };

  const storeFor = (table: { __table?: string }): Map<string, Row> => {
    if (table.__table === 'envelopes') return envelopeStore;
    if (table.__table === 'requests') return requestStore;
    return grantStore;
  };

  const envelopeKey = (data: Row) => `${String(data.field)}:${String(data.keyId)}`;

  function queryable(rows: () => Row[]) {
    const p = Promise.resolve(rows());
    return {
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
      limit: (n: number) => Promise.resolve(rows().slice(0, n)),
    };
  }

  return {
    db: {
      insert: (table: { __table?: string }) => ({
        values: (data: Row) => {
          const store = storeFor(table);
          if (table.__table === 'envelopes') {
            store.set(envelopeKey(data), data);
            return {
              ...queryable(() => []),
              onConflictDoUpdate: () => {
                store.set(envelopeKey(data), data);
                return Promise.resolve([]);
              },
            };
          }
          store.set(String(data.id), { createdAt: new Date(), ...data });
          return Promise.resolve([]);
        },
      }),
      update: (table: { __table?: string }) => ({
        set: (patch: Row) => ({
          where: (predicate: Predicate) => {
            const store = storeFor(table);
            const touched: Row[] = [];
            for (const [id, row] of store) {
              if (predicate(row)) {
                const next = { ...row, ...patch };
                store.set(id, next);
                touched.push(next);
              }
            }
            return { ...queryable(() => []), returning: () => Promise.resolve(touched) };
          },
        }),
      }),
      select: () => ({
        from: (table: { __table?: string }) => ({
          where: (predicate: Predicate) => queryable(() => [...storeFor(table).values()].filter(predicate)),
        }),
      }),
    },
    vaultDelegationGrants,
    vaultOwnerEnvelopes,
    vaultGrantRequests,
    channelLinks: {},
  };
});

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

import { sealAndStore, sealAndStoreV2, rotateAndStore, loadAndUnseal, vaultService } from '../index.js';
import { getNodeXPrivateKey, _resetSealingCache } from '../sealing.js';

const FIELD = 'github-oauth:did:imajin:rotate';

function activeGrants(): Row[] {
  return [...grantStore.values()].filter((r) => r.status === 'active');
}

function fieldKeyFromGrant(grant: Row): Buffer {
  return unwrapFieldKey(
    { encryptedKey: String(grant.wrappedKey), nonce: String(grant.wrappedNonce) },
    String(grant.ownerXPub),
    getNodeXPrivateKey(),
  );
}

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  requestStore.clear();
  _resetSealingCache();
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
  await unlink(tmpVaultPath).catch(() => undefined);
});

describe('rotateAndStore — not found', () => {
  it('throws rather than creating a field, directing callers to sealAndStore', async () => {
    await expect(rotateAndStore('never-sealed-field', 'x')).rejects.toThrow(/not found/i);
  });
});

describe('rotateAndStore — v1 fields (regression)', () => {
  it('stays v1 after rotation: no custodyScheme, chained previousCid, no grants touched', async () => {
    await sealAndStore(FIELD, 'original-secret');
    const original = await vaultService.peek(FIELD);

    const rotated = await rotateAndStore(FIELD, 'rotated-secret');

    expect(rotated.custodyScheme).toBeUndefined();
    expect(rotated.previousCid).toBe(original!.cid);
    expect(await loadAndUnseal(FIELD)).toBe('rotated-secret');
    expect(grantStore.size).toBe(0);
    expect(envelopeStore.size).toBe(0);
  });
});

describe('rotateAndStore — v2 fields (#1546 fix)', () => {
  it('stays v2 after rotation instead of silently downgrading to v1', async () => {
    await sealAndStoreV2(FIELD, 'original-secret');
    const original = await vaultService.peek(FIELD);
    const [originalGrant] = activeGrants();
    const originalFieldKey = fieldKeyFromGrant(originalGrant!).toString('hex');

    const rotated = await rotateAndStore(FIELD, 'rotated-secret');

    // The core regression: custody must NOT have downgraded.
    expect(rotated.custodyScheme).toBe('delegation-grant');
    expect(rotated.previousCid).toBe(original!.cid);
    expect(await loadAndUnseal(FIELD)).toBe('rotated-secret');

    // The old grant is superseded and its key material erased — not left
    // dangling as a stale, still-"active" row.
    const supersededGrant = grantStore.get(String(originalGrant!.id))!;
    expect(supersededGrant.status).toBe('superseded');
    expect(supersededGrant.wrappedKey).toBe('');
    expect(supersededGrant.wrappedNonce).toBe('');

    // A single new active grant exists, wrapping a DIFFERENT field key — proof
    // the rotation actually generated a fresh AES key rather than re-wrapping
    // the old one under a new status.
    const nowActive = activeGrants();
    expect(nowActive).toHaveLength(1);
    expect(nowActive[0]!.id).not.toBe(originalGrant!.id);
    const newFieldKey = fieldKeyFromGrant(nowActive[0]!).toString('hex');
    expect(newFieldKey).not.toBe(originalFieldKey);
  });

  it('does not downgrade to v1 when rotating under Tier 1, and queues a fresh grant request rather than a self-grant', async () => {
    // Seal under Tier 0 first so there is an active self-grant to rotate away
    // from, then flip to Tier 1 before rotating — mirroring a node that was
    // promoted to an external owner agent between seals.
    await sealAndStoreV2(FIELD, 'original-secret');
    const [originalGrant] = activeGrants();

    const ownerXKeypair = deriveXKeypairFromEd25519(randomBytes(32).toString('hex'), 'test-owner-x25519');
    process.env.VAULT_OWNER_X_PUB = ownerXKeypair.publicKey;
    process.env.VAULT_OWNER_ED_PUB = 'b'.repeat(64);

    const rotated = await rotateAndStore(FIELD, 'rotated-secret');

    // Must still be v2 — the bug this issue exists for is a silent downgrade
    // to v1, and that must not happen regardless of tier.
    expect(rotated.custodyScheme).toBe('delegation-grant');

    // Tier 1 queues a request rather than self-granting.
    expect(requestStore.size).toBe(1);

    // Documented, pre-existing behaviour (out of scope for this fix): a
    // Tier-1 re-seal does not supersede the prior grant at seal time — that
    // happens later, at fulfilment. The old grant is therefore still present
    // and still 'active' immediately after rotation.
    expect(grantStore.get(String(originalGrant!.id))!.status).toBe('active');
  });
});
