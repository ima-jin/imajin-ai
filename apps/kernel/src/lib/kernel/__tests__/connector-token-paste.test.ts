/**
 * Tests for `createConnectorTokenPaste`'s credential-status accounting (#1724).
 *
 * Disconnecting a sealed token-paste connector (Gemini, Anthropic, GCP) revokes
 * the sealed key's `vault_delegation_grants` row via `revokeApiKey` but
 * deliberately leaves the underlying vault entry (ciphertext) in place. `keySealed`
 * used to be `vaultFieldExists(field)`, which only checks that the entry exists
 * and verifies; it says nothing about whether an ACTIVE grant currently covers
 * it. So a disconnected key kept reporting `keySealed: true` forever — the UI
 * showed "API Key sealed" with no way to disconnect again (nothing left to
 * revoke) and no way to re-paste (the credential form stayed hidden behind the
 * stale sealed state).
 *
 * This double actually evaluates WHERE clauses (`and`/`eq`/`like`) and enforces
 * the same invariant the real `uniq_vault_delegation_active` PARTIAL unique
 * index does — unique among ACTIVE rows only — so a passing "re-seal after
 * revoke" test here means the same insert would not violate the real
 * constraint in Postgres either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';

type Row = Record<string, unknown>;

const { tmpVaultPath, grantStore, envelopeStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-connector-token-paste-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return {
    tmpVaultPath,
    grantStore: new Map<string, Row>(),
    envelopeStore: new Map<string, Row>(),
  };
});

// ── Clause-evaluating drizzle double (mirrors grantee-custody.test.ts) ──────

type Clause =
  | { kind: 'and'; parts: Clause[] }
  | { kind: 'or'; parts: Clause[] }
  | { kind: 'eq'; col: string; value: unknown }
  | { kind: 'gt'; col: string; value: unknown }
  | { kind: 'isNull'; col: string }
  | { kind: 'like'; col: string; pattern: string };

vi.mock('drizzle-orm', () => ({
  and: (...parts: Clause[]) => ({ kind: 'and', parts: parts.filter(Boolean) }),
  or: (...parts: Clause[]) => ({ kind: 'or', parts: parts.filter(Boolean) }),
  eq: (col: string, value: unknown) => ({ kind: 'eq', col, value }),
  gt: (col: string, value: unknown) => ({ kind: 'gt', col, value }),
  isNull: (col: string) => ({ kind: 'isNull', col }),
  like: (col: string, pattern: string) => ({ kind: 'like', col, pattern }),
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
  const channelLinks = columns(['channel', 'did', 'appDid', 'status', 'scopes']);

  function storeFor(table: unknown): Map<string, Row> | undefined {
    if (table === vaultDelegationGrants) return grantStore;
    if (table === vaultOwnerEnvelopes) return envelopeStore;
    return undefined;
  }

  /** Translate a SQL LIKE pattern (`%`/`_` wildcards) into a RegExp. */
  function likeToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = escaped.replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${source}$`);
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
      case 'like':
        return likeToRegExp(clause.pattern).test(String(row[clause.col] ?? ''));
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

  /**
   * Mirrors the PARTIAL unique index `uniq_vault_delegation_active` (subject,
   * granted_to, field, key_id) WHERE status = 'active' (migration 0079). Only
   * ACTIVE rows participate — a revoked/superseded row for the same tuple must
   * never block a fresh active insert, which is exactly what re-sealing after
   * a disconnect relies on.
   */
  function violatesActiveUniqueness(data: Row): boolean {
    if (data.status !== 'active') return false;
    for (const row of grantStore.values()) {
      if (
        row.status === 'active' &&
        row.subject === data.subject &&
        row.grantedTo === data.grantedTo &&
        row.field === data.field &&
        row.keyId === data.keyId
      ) {
        return true;
      }
    }
    return false;
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
          if (store === grantStore) {
            if (violatesActiveUniqueness(data)) {
              throw new Error(
                'duplicate key value violates unique constraint "uniq_vault_delegation_active"',
              );
            }
            store.set(String(data.id), data);
          } else if (store) {
            store.set(String(data.id), data);
          }
          return thenable(() => [], { onConflictDoUpdate: () => Promise.resolve([]) });
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
    },
    vaultDelegationGrants,
    vaultOwnerEnvelopes,
    vaultGrantRequests,
    channelLinks,
  };
});

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

import { createConnectorTokenPaste } from '../connector-token-paste.js';
import { _resetSealingCache } from '../../vault/sealing.js';

const OWNER_DID = 'did:imajin:connector-token-paste-owner';

const connector = createConnectorTokenPaste({
  id: 'testprov',
  displayName: 'TestProv',
  connectorDid: 'did:imajin:testprov-connector',
  channel: 'testprov',
});

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  _resetSealingCache();
  process.env.AUTH_PRIVATE_KEY = randomBytes(32).toString('hex');
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  await unlink(tmpVaultPath).catch(() => undefined);
});

describe('keySealed', () => {
  it('is false before anything is sealed', async () => {
    expect(await connector.keySealed(OWNER_DID)).toBe(false);
  });

  it('is true immediately after sealing (Tier 0 self-grant is active at seal time)', async () => {
    await connector.sealApiKey(OWNER_DID, 'sk-test-key');
    expect(await connector.keySealed(OWNER_DID)).toBe(true);
  });

  // The bug (#1724): vaultFieldExists reports true for a vault entry that
  // still exists, and revokeApiKey deliberately never deletes that entry — so
  // checking existence alone can never observe a disconnect.
  it('is false once the grant is revoked, even though the sealed entry still exists (#1724)', async () => {
    await connector.sealApiKey(OWNER_DID, 'sk-test-key');
    expect(await connector.keySealed(OWNER_DID)).toBe(true);

    const revoked = await connector.revokeApiKey(OWNER_DID);
    expect(revoked).toBe(true);

    expect(await connector.keySealed(OWNER_DID)).toBe(false);
  });

  it('revokeApiKey reports false when there is nothing active left to revoke', async () => {
    await connector.sealApiKey(OWNER_DID, 'sk-test-key');
    await connector.revokeApiKey(OWNER_DID);

    // Disconnecting again — the exact "stuck" step from the bug report.
    expect(await connector.revokeApiKey(OWNER_DID)).toBe(false);
  });

  it('does not report an unrelated DID as sealed after this DID disconnects', async () => {
    const otherDid = 'did:imajin:connector-token-paste-other';
    await connector.sealApiKey(OWNER_DID, 'sk-test-key');
    await connector.sealApiKey(otherDid, 'sk-other-key');

    await connector.revokeApiKey(OWNER_DID);

    expect(await connector.keySealed(OWNER_DID)).toBe(false);
    expect(await connector.keySealed(otherDid)).toBe(true);
  });
});

describe('re-sealing after a revoke (#1724 item 4)', () => {
  it('succeeds without violating the active-grant uniqueness constraint', async () => {
    await connector.sealApiKey(OWNER_DID, 'sk-first-key');
    await connector.revokeApiKey(OWNER_DID);
    expect(await connector.keySealed(OWNER_DID)).toBe(false);

    // Re-pasting the key is the recovery path the bug report says was blocked
    // ("can't re-paste — UI thinks a key is still sealed"). The insert below
    // goes through the same double that throws on a real partial-unique
    // violation, so this failing would mean the real DB insert fails too.
    await expect(connector.sealApiKey(OWNER_DID, 'sk-second-key')).resolves.toBeUndefined();

    expect(await connector.keySealed(OWNER_DID)).toBe(true);
  });

  it('supports multiple disconnect/re-seal cycles on the same field', async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await connector.sealApiKey(OWNER_DID, `sk-cycle-${cycle}`);
      expect(await connector.keySealed(OWNER_DID)).toBe(true);
      await connector.revokeApiKey(OWNER_DID);
      expect(await connector.keySealed(OWNER_DID)).toBe(false);
    }
  });
});
