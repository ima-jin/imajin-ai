/**
 * Tests for the self-healing active-grant insert (#1756).
 *
 * `sealAndStoreV2`'s supersede-then-insert used to skip the supersede step
 * whenever the just-peeked vault entry's `custodyScheme` didn't say
 * 'delegation-grant' — a proxy for "is there an active grant to supersede?"
 * that could diverge from what `vault_delegation_grants` actually held. When
 * it diverged, the INSERT collided with `uniq_vault_delegation_active`
 * instead of rotating gracefully — this is what crashed the QuickBooks
 * `connect_error` reported in #1756.
 *
 * This suite pins two things:
 *   1. The proactive supersede is now unconditional, so a normal rotation
 *      never even reaches a conflicting insert (the common case).
 *   2. If an insert conflicts anyway (a concurrent racing seal, or any other
 *      unmodeled divergence), the insert self-heals: it supersedes whatever
 *      currently occupies the tuple and retries once, instead of throwing.
 *   3. A genuinely unrelated insert failure is NOT swallowed by that
 *      self-healing path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';

type Row = Record<string, unknown>;

const { tmpVaultPath, grantStore } = vi.hoisted(() => {
   
  const { join } = require('node:path') as typeof import('node:path');
   
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-duplicate-grant-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return { tmpVaultPath, grantStore: new Map<string, Row>() };
});

// Toggled by individual tests to force the next grant insert to fail the way
// a real `uniq_vault_delegation_active` collision (or an unrelated DB error)
// would, so the self-healing retry path can be exercised deterministically.
let nextInsertError: { code?: string; constraint_name?: string; message: string } | null = null;

type Predicate = (row: Row) => boolean;

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
  const vaultOwnerEnvelopes = { __table: 'envelopes' };
  const vaultGrantRequests = { __table: 'requests' };
  const envelopeStore = new Map<string, Row>();

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
          if (table.__table === 'envelopes') {
            envelopeStore.set(`${String(data.field)}:${String(data.keyId)}`, data);
            return {
              ...queryable(() => []),
              onConflictDoUpdate: () => Promise.resolve([]),
            };
          }
          if (table.__table === 'requests') {
            return Promise.resolve([]);
          }
          if (nextInsertError) {
            const toThrow = nextInsertError;
            nextInsertError = null;
            const err = Object.assign(new Error(toThrow.message), toThrow);
            return Promise.reject(err);
          }
          grantStore.set(String(data.id), { createdAt: new Date(), ...data });
          return Promise.resolve([]);
        },
      }),
      update: (table: { __table?: string }) => ({
        set: (patch: Row) => ({
          where: (predicate: Predicate) => {
            const touched: Row[] = [];
            if (table.__table === 'grants') {
              for (const [id, row] of grantStore) {
                if (predicate(row)) {
                  const next = { ...row, ...patch };
                  grantStore.set(id, next);
                  touched.push(next);
                }
              }
            }
            return { ...queryable(() => []), returning: () => Promise.resolve(touched) };
          },
        }),
      }),
      select: () => ({
        from: (table: { __table?: string }) => ({
          where: (predicate: Predicate) => queryable(() =>
            table.__table === 'grants' ? [...grantStore.values()].filter(predicate) : [],
          ),
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

import { sealAndStoreV2, loadAndUnseal } from '../index.js';
import { _resetSealingCache } from '../sealing.js';

const FIELD = 'quickbooks-config:did:imajin:agrifortress-owner';

function activeGrants(): Row[] {
  return [...grantStore.values()].filter((r) => r.status === 'active');
}

beforeEach(() => {
  grantStore.clear();
  nextInsertError = null;
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

describe('sealAndStoreV2 — self-healing active-grant insert (#1756)', () => {
  it('a normal rotation supersedes proactively and never hits a conflicting insert', async () => {
    await sealAndStoreV2(FIELD, 'first-secret');
    expect(activeGrants()).toHaveLength(1);

    await sealAndStoreV2(FIELD, 'second-secret');

    expect(activeGrants()).toHaveLength(1);
    expect(await loadAndUnseal(FIELD)).toBe('second-secret');
  });

  it('supersedes and retries when the insert collides with an existing active grant', async () => {
    await sealAndStoreV2(FIELD, 'first-secret');
    expect(activeGrants()).toHaveLength(1);

    // Simulate the divergence #1756 describes: the insert collides with
    // `uniq_vault_delegation_active` despite the proactive supersede having
    // already run (e.g. a concurrent racing seal for the same tuple).
    nextInsertError = {
      code: '23505',
      constraint_name: 'uniq_vault_delegation_active',
      message: 'duplicate key value violates unique constraint "uniq_vault_delegation_active"',
    };

    const { grantId } = await sealAndStoreV2(FIELD, 'second-secret');

    expect(grantId).not.toBeNull();
    expect(await loadAndUnseal(FIELD)).toBe('second-secret');
    // Exactly one active grant survives the retry.
    expect(activeGrants()).toHaveLength(1);
  });

  it('does not swallow an unrelated insert failure', async () => {
    nextInsertError = { code: '53300', message: 'too many connections' };

    await expect(sealAndStoreV2(FIELD, 'first-secret')).rejects.toThrow(/too many connections/);
    expect(activeGrants()).toHaveLength(0);
  });
});
