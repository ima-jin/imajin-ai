/**
 * Batch v1→v2 custody migration (#1537).
 *
 * These pin the behaviour the driver exists for: a dry run changes nothing, a
 * real run upgrades v1 fields one at a time and verifies each still unseals,
 * and — the part with no static answer — a canary that never comes back
 * readable stops the batch after touching exactly one field rather than
 * silently sealing the rest into a lockout.
 *
 * The DB is a stateful in-memory double, same shape as grant-leases.test.ts
 * and renewal.test.ts, extended with a `vault_grant_requests` store so the
 * Tier 1 request path and the stale-pending guard can both be exercised with
 * real crypto rather than mocked away. VAULT_PATH is redirected via
 * vi.hoisted() so the module-level vault singleton uses an isolated file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { deriveXKeypairFromEd25519 } from '@imajin/vault-core';

type Row = Record<string, unknown>;

/**
 * Build a raw vault entry object for tests that write directly to the vault
 * file (bypassing sealAndStore/sealAndStoreV2) so selection logic can be
 * exercised against fixtures no real seal call could produce on demand —
 * out-of-order timestamps, superseded history, and bare custodyScheme
 * omission. Never asserted for integrity by selection code, so the crypto
 * fields below are deliberately inert placeholders, not real ciphertext.
 */
function rawEntry(overrides: {
  field: string;
  timestamp: string;
  senderDid: string;
  custodyScheme?: 'node-sealed' | 'delegation-grant';
  deleted?: boolean;
  encrypted?: string;
  nonce?: string;
}): Row {
  const { custodyScheme, ...rest } = overrides;
  return {
    version: custodyScheme === 'delegation-grant' ? 2 : 1,
    cid: `cid-${overrides.field}-${overrides.timestamp}`,
    encrypted: 'encrypted-placeholder',
    nonce: 'nonce-placeholder',
    senderPubkey: 'pubkey-placeholder',
    keyId: 'key-placeholder',
    signature: 'signature-placeholder',
    ...rest,
    ...(custodyScheme !== undefined ? { custodyScheme } : {}),
  };
}

/** Write a raw vault file directly, bypassing the service's append-only `set()`. */
async function writeRawVault(entries: Row[]): Promise<void> {
  await writeFile(tmpVaultPath, JSON.stringify({ version: 1, entries }), 'utf8');
}

const { tmpVaultPath, grantStore, envelopeStore, requestStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-migrate-custody-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return {
    tmpVaultPath,
    grantStore: new Map<string, Row>(),
    envelopeStore: new Map<string, Row>(),
    requestStore: new Map<string, Row>(),
  };
});

type Predicate = (row: Row) => boolean;

// Real column-based filtering, not the single-field "just return the only
// active row" shortcut grant-leases.test.ts/renewal.test.ts get away with —
// this file seals several DISTINCT fields at once, so a query that ignores
// its own WHERE clause would apply field-a's grant to field-b's ciphertext.
//
// `eq`/`and`/`or`/`isNull`/`gt` are replaced with real predicate builders so
// the mocked `db` can evaluate them against plain row objects. This works
// because `@/src/db` is fully mocked too: the "columns" production code reads
// off vaultDelegationGrants/vaultOwnerEnvelopes/vaultGrantRequests below are
// just their own property names (e.g. `field: 'field'`), so `eq(table.field,
// value)` becomes a predicate on `row.field`.
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

import { sealAndStore, sealAndStoreV2, loadAndUnseal, vaultService } from '../index.js';
import { migrateCustody } from '../migrate-custody.js';
import { _resetSealingCache } from '../sealing.js';

const noSleep = async () => undefined;

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

// ── Dry run ───────────────────────────────────────────────────────────────────

describe('migrateCustody — dry run', () => {
  it('reports v1 fields and mutates nothing', async () => {
    await sealAndStore('field-b', 'secret-b');
    await sealAndStore('field-a', 'secret-a');
    await sealAndStoreV2('field-c', 'secret-c'); // already v2 — must not appear

    const report = await migrateCustody({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.aborted).toBe(false);
    expect(report.totalV1Fields).toBe(2);
    expect(report.candidateCount).toBe(2);
    // Sorted, so the order is deterministic regardless of seal order.
    expect(report.results).toEqual([
      { field: 'field-a', status: 'would-upgrade', ownerDidTruncated: expect.any(String) },
      { field: 'field-b', status: 'would-upgrade', ownerDidTruncated: expect.any(String) },
    ]);

    // Nothing changed: both fields are still node-sealed, no grant issued.
    expect((await vaultService.peek('field-a'))!.custodyScheme).not.toBe('delegation-grant');
    expect((await vaultService.peek('field-b'))!.custodyScheme).not.toBe('delegation-grant');
    expect(grantStore.size).toBe(1); // only field-c's pre-existing grant
  });

  it('reports nothing when there are no v1 fields left', async () => {
    await sealAndStoreV2('field-c', 'secret-c');

    const report = await migrateCustody({ dryRun: true });

    expect(report.totalV1Fields).toBe(0);
    expect(report.results).toEqual([]);
  });
});

// ── Real run: batching and verification ──────────────────────────────────────

describe('migrateCustody — real run (Tier 0)', () => {
  it('upgrades every v1 field and each still unseals afterwards', async () => {
    await sealAndStore('field-a', 'secret-a');
    await sealAndStore('field-b', 'secret-b');
    await sealAndStore('field-c', 'secret-c');

    const report = await migrateCustody({ dryRun: false, sleep: noSleep });

    expect(report.aborted).toBe(false);
    expect(report.results).toHaveLength(3);
    for (const result of report.results) {
      expect(result.status).toBe('upgraded');
      expect(typeof result.grantId).toBe('string');
    }

    expect(await loadAndUnseal('field-a')).toBe('secret-a');
    expect(await loadAndUnseal('field-b')).toBe('secret-b');
    expect(await loadAndUnseal('field-c')).toBe('secret-c');
    expect((await vaultService.peek('field-a'))!.custodyScheme).toBe('delegation-grant');
  });

  it('honours limit, leaving the rest for a later call', async () => {
    await sealAndStore('field-a', 'secret-a');
    await sealAndStore('field-b', 'secret-b');
    await sealAndStore('field-c', 'secret-c');

    const first = await migrateCustody({ dryRun: false, limit: 1, sleep: noSleep });

    expect(first.totalV1Fields).toBe(3);
    expect(first.candidateCount).toBe(1);
    expect(first.results).toEqual([{ field: 'field-a', status: 'upgraded', grantId: expect.any(String) }]);

    // field-b and field-c are untouched.
    const remaining = await migrateCustody({ dryRun: true });
    expect(remaining.totalV1Fields).toBe(2);
    expect(remaining.results.map((r) => r.field)).toEqual(['field-b', 'field-c']);
  });

  it('does nothing when there are no v1 fields to migrate', async () => {
    const report = await migrateCustody({ dryRun: false, sleep: noSleep });
    expect(report.results).toEqual([]);
    expect(report.aborted).toBe(false);
  });
});

// ── Canary abort ──────────────────────────────────────────────────────────────

describe('migrateCustody — canary failure', () => {
  it('refuses to migrate the rest when the canary never becomes readable', async () => {
    // Tier 1: sealAndStoreV2 queues a grant request instead of self-granting.
    // With no owner agent to fulfil it, loadAndUnseal will keep throwing
    // VaultDelegationError — exactly the "did not come back readable" case
    // the canary exists to catch.
    const ownerXKeypair = deriveXKeypairFromEd25519(randomBytes(32).toString('hex'), 'test-owner-x25519');
    process.env.VAULT_OWNER_X_PUB = ownerXKeypair.publicKey;
    process.env.VAULT_OWNER_ED_PUB = 'b'.repeat(64);

    await sealAndStore('field-a', 'secret-a');
    await sealAndStore('field-b', 'secret-b');

    const report = await migrateCustody({
      dryRun: false,
      timeoutMs: 20,
      pollIntervalMs: 5,
      sleep: noSleep,
    });

    expect(report.tier1).toBe(true);
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/canary field 'field-a' did not come back readable/i);
    // #1556: the abort says WHY. This is the transient case — a real grant
    // waiting on an owner agent — and must not read like a broken entry.
    expect(report.abortReason).toMatch(/still pending/i);
    expect(report.abortReason).not.toMatch(/verification failed/i);

    // Only the canary was touched; the rest of the batch was never attempted.
    expect(report.results).toEqual([
      { field: 'field-a', status: 'verify-failed', grantId: null, error: expect.any(String) },
    ]);
    expect(report.results[0].error).toMatch(/still pending/i);
    expect((await vaultService.peek('field-b'))!.custodyScheme).not.toBe('delegation-grant');

    // The pending grant request is real — this is a Tier 1 field waiting on
    // an owner agent, not a corrupted entry.
    expect(requestStore.size).toBe(1);
  });
});

// ── Stale-pending guard ───────────────────────────────────────────────────────

describe('migrateCustody — stale pending guard', () => {
  it('refuses to start when a grant request has been pending past the threshold', async () => {
    await sealAndStore('field-a', 'secret-a');

    requestStore.set('vgr_stale', {
      id: 'vgr_stale',
      field: 'field-b',
      keyId: 'kid-stale',
      requestId: 'req-stale',
      nodeXPub: 'x'.repeat(64),
      ownerXPub: 'y'.repeat(64),
      wrappedFieldKey: 'z',
      wrappedFieldKeyNonce: 'n',
      status: 'pending',
      createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes old
    });

    const report = await migrateCustody({
      dryRun: false,
      stalePendingThresholdMs: 5 * 60 * 1000, // 5 minutes
      sleep: noSleep,
    });

    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/pending/i);
    expect(report.abortReason).toMatch(/req-stale|field-b/);
    // Nothing was attempted — not even the canary.
    expect(report.results).toEqual([]);

    expect((await vaultService.peek('field-a'))!.custodyScheme).not.toBe('delegation-grant');
  });

  it('does not trip on a recent pending request', async () => {
    await sealAndStore('field-a', 'secret-a');

    requestStore.set('vgr_fresh', {
      id: 'vgr_fresh',
      field: 'field-b',
      keyId: 'kid-fresh',
      requestId: 'req-fresh',
      nodeXPub: 'x'.repeat(64),
      ownerXPub: 'y'.repeat(64),
      wrappedFieldKey: 'z',
      wrappedFieldKeyNonce: 'n',
      status: 'pending',
      createdAt: new Date(),
    });

    const report = await migrateCustody({
      dryRun: false,
      stalePendingThresholdMs: 5 * 60 * 1000,
      sleep: noSleep,
    });

    expect(report.aborted).toBe(false);
    expect(report.results).toEqual([{ field: 'field-a', status: 'upgraded', grantId: expect.any(String) }]);
  });
});

// ── Selection: timestamp-based, not array position (#2311) ────────────────────

describe('migrateCustody — live v1 selection (#2311)', () => {
  it('selects the true latest entry per field by timestamp, not array position', async () => {
    // github-oauth: a stale, already-v2-looking entry was appended AFTER (a
    // higher array index than) a live v1 entry with a LATER timestamp — the
    // exact reordering that hid fields like this from the Aug-1 batch
    // (#1537). Selecting by array position would treat this field as already
    // migrated and skip it; selecting by timestamp correctly finds the live
    // v1 entry as the true latest.
    const entries: Row[] = [
      rawEntry({
        field: 'github-oauth:did:imajin:owner-a',
        timestamp: '2026-01-01T00:00:00.000Z',
        senderDid: 'did:imajin:owner-a',
      }),
      rawEntry({
        field: 'github-oauth:did:imajin:owner-a',
        timestamp: '2026-03-01T00:00:00.000Z', // true latest — still v1
        senderDid: 'did:imajin:owner-a',
      }),
      rawEntry({
        field: 'github-oauth:did:imajin:owner-a',
        timestamp: '2026-02-01T00:00:00.000Z', // chronologically older than the entry above...
        senderDid: 'did:imajin:owner-a',
        custodyScheme: 'delegation-grant', // ...but appended LAST in the array
      }),
      // github-config: single live v1 entry, custodyScheme explicit.
      rawEntry({
        field: 'github-config:did:imajin:owner-b',
        timestamp: '2026-01-05T00:00:00.000Z',
        senderDid: 'did:imajin:owner-b',
        custodyScheme: 'node-sealed',
      }),
      // gemini-model-id: custodyScheme entirely absent — must still count as live v1.
      rawEntry({
        field: 'gemini-model-id:did:imajin:owner-c',
        timestamp: '2026-01-06T00:00:00.000Z',
        senderDid: 'did:imajin:owner-c',
      }),
      // warp-environment-id: superseded history, then a deleted latest entry — excluded entirely.
      rawEntry({
        field: 'warp-environment-id:did:imajin:owner-d',
        timestamp: '2026-01-01T00:00:00.000Z',
        senderDid: 'did:imajin:owner-d',
      }),
      rawEntry({
        field: 'warp-environment-id:did:imajin:owner-d',
        timestamp: '2026-01-07T00:00:00.000Z',
        senderDid: 'did:imajin:owner-d',
        deleted: true,
      }),
      // openai-model-id: already fully migrated to v2 — excluded.
      rawEntry({
        field: 'openai-model-id:did:imajin:owner-e',
        timestamp: '2026-01-08T00:00:00.000Z',
        senderDid: 'did:imajin:owner-e',
        custodyScheme: 'delegation-grant',
      }),
      // xai-model-id: another plain live v1 field, rounding out a mixed-prefix set.
      rawEntry({
        field: 'xai-model-id:did:imajin:owner-f',
        timestamp: '2026-01-09T00:00:00.000Z',
        senderDid: 'did:imajin:owner-f',
      }),
    ];
    await writeRawVault(entries);

    const report = await migrateCustody({ dryRun: true });

    expect(report.totalV1Fields).toBe(4);
    expect(report.results.map((r) => r.field)).toEqual([
      'gemini-model-id:did:imajin:owner-c',
      'github-config:did:imajin:owner-b',
      'github-oauth:did:imajin:owner-a',
      'xai-model-id:did:imajin:owner-f',
    ]);
    for (const result of report.results) {
      expect(result.status).toBe('would-upgrade');
      expect(typeof result.ownerDidTruncated).toBe('string');
    }

    // Mutates nothing.
    expect(grantStore.size).toBe(0);
    expect(envelopeStore.size).toBe(0);
    expect(requestStore.size).toBe(0);
  });
});

// ── Dry run leaks nothing (#2311) ──────────────────────────────────────────────

describe('migrateCustody — dry run leaks nothing (#2311)', () => {
  it('never surfaces encrypted material and mutates no store', async () => {
    await writeRawVault([
      rawEntry({
        field: 'field-a',
        timestamp: '2026-01-01T00:00:00.000Z',
        senderDid: 'did:imajin:owner-a',
        encrypted: 'TOP-SECRET-CIPHERTEXT',
        nonce: 'TOP-SECRET-NONCE',
      }),
    ]);

    const report = await migrateCustody({ dryRun: true });

    expect(JSON.stringify(report)).not.toMatch(/TOP-SECRET/);
    expect(grantStore.size).toBe(0);
    expect(envelopeStore.size).toBe(0);
    expect(requestStore.size).toBe(0);
  });

  it('truncates a long owner DID to 20 chars in the dry-run plan', async () => {
    const longDid = `did:imajin:${'a'.repeat(40)}`;
    await writeRawVault([
      rawEntry({ field: 'field-a', timestamp: '2026-01-01T00:00:00.000Z', senderDid: longDid }),
    ]);

    const report = await migrateCustody({ dryRun: true });

    expect(report.results).toEqual([
      { field: 'field-a', status: 'would-upgrade', ownerDidTruncated: longDid.slice(0, 20) },
    ]);
    expect(report.results[0].ownerDidTruncated).toHaveLength(20);
  });

  it('does not truncate a short owner DID', async () => {
    const shortDid = 'did:imajin:short';
    await writeRawVault([
      rawEntry({ field: 'field-a', timestamp: '2026-01-01T00:00:00.000Z', senderDid: shortDid }),
    ]);

    const report = await migrateCustody({ dryRun: true });

    expect(report.results[0].ownerDidTruncated).toBe(shortDid);
  });
});

// ── Targeted --fields mode (#2311) ─────────────────────────────────────────────

describe('migrateCustody — targeted fields mode (#2311)', () => {
  it('restricts the dry-run plan to exactly the requested fields and reports the rest as not found', async () => {
    await writeRawVault([
      rawEntry({ field: 'field-a', timestamp: '2026-01-01T00:00:00.000Z', senderDid: 'did:imajin:owner-a' }),
      rawEntry({ field: 'field-b', timestamp: '2026-01-02T00:00:00.000Z', senderDid: 'did:imajin:owner-b' }),
      rawEntry({ field: 'field-c', timestamp: '2026-01-03T00:00:00.000Z', senderDid: 'did:imajin:owner-c' }),
    ]);

    const report = await migrateCustody({ dryRun: true, fields: ['field-a', 'field-c', 'does-not-exist'] });

    expect(report.totalV1Fields).toBe(3);
    expect(report.candidateCount).toBe(2);
    expect(report.results.map((r) => r.field)).toEqual(['field-a', 'field-c']);
    expect(report.notFound).toEqual(['does-not-exist']);
  });

  it('omits notFound when fields is not passed', async () => {
    await sealAndStore('field-a', 'secret-a');

    const report = await migrateCustody({ dryRun: true });

    expect(report.notFound).toBeUndefined();
  });

  it('migrates only the requested fields on a real run, leaving the rest untouched', async () => {
    await sealAndStore('field-a', 'secret-a');
    await sealAndStore('field-b', 'secret-b');

    const report = await migrateCustody({ dryRun: false, fields: ['field-a'], sleep: noSleep });

    expect(report.aborted).toBe(false);
    expect(report.results).toEqual([{ field: 'field-a', status: 'upgraded', grantId: expect.any(String) }]);
    expect((await vaultService.peek('field-a'))!.custodyScheme).toBe('delegation-grant');
    expect((await vaultService.peek('field-b'))!.custodyScheme).not.toBe('delegation-grant');
  });
});

// ── Idempotency (#2311) ─────────────────────────────────────────────────────────

describe('migrateCustody — idempotency (#2311)', () => {
  it('rerunning after a full migration is a no-op', async () => {
    await sealAndStore('field-a', 'secret-a');
    await sealAndStore('field-b', 'secret-b');

    const first = await migrateCustody({ dryRun: false, sleep: noSleep });
    expect(first.aborted).toBe(false);
    expect(first.results).toHaveLength(2);

    const second = await migrateCustody({ dryRun: false, sleep: noSleep });
    expect(second.results).toEqual([]);
    expect(second.totalV1Fields).toBe(0);
    expect(second.aborted).toBe(false);
  });
});
