/**
 * Tests for `vaultFieldStatus` (#1521).
 *
 * Names the state that was previously invisible: a v2 delegation-grant entry
 * can exist and verify while having no active grant covering it (fresh Tier 1
 * seal awaiting the owner agent, or a lapsed grant awaiting renewal). Before
 * this module, `vaultFieldExists` reported that as `true` (it only checks
 * integrity, not grant coverage) and `loadAndUnseal` threw — a card would say
 * "sealed" and then fail on use. These tests pin the four states directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import type { VaultEntry } from '@imajin/vault-core';

type Row = Record<string, unknown>;

type Clause =
  | { kind: 'and'; parts: Clause[] }
  | { kind: 'or'; parts: Clause[] }
  | { kind: 'eq'; col: string; value: unknown }
  | { kind: 'gt'; col: string; value: unknown }
  | { kind: 'isNull'; col: string };

const { tmpVaultPath, grantStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-field-status-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return { tmpVaultPath, grantStore: new Map<string, Row>() };
});

// drizzle-orm's clause builders are mocked into plain, inspectable objects so
// the DB double below can actually evaluate a WHERE clause instead of hardcoding
// one query shape — field-status.ts issues two distinct grants queries (active,
// and — #1774 — ever-revoked), and each must see only the rows its own clause
// matches.
vi.mock('drizzle-orm', () => ({
  and: (...parts: Clause[]) => ({ kind: 'and', parts: parts.filter(Boolean) }),
  or: (...parts: Clause[]) => ({ kind: 'or', parts: parts.filter(Boolean) }),
  eq: (col: string, value: unknown) => ({ kind: 'eq', col, value }),
  gt: (col: string, value: unknown) => ({ kind: 'gt', col, value }),
  isNull: (col: string) => ({ kind: 'isNull', col }),
}));

vi.mock('@/src/db', () => {
  const columns = (names: string[]) => Object.fromEntries(names.map((n) => [n, n]));
  const vaultDelegationGrants = { __table: 'grants', ...columns([
    'id', 'subject', 'grantedTo', 'field', 'status', 'expiresAt', 'createdAt', 'revokedAt',
  ]) };
  const vaultOwnerEnvelopes = { __table: 'envelopes' };
  const vaultGrantRequests = { __table: 'requests' };

  function thenable<T extends object>(rows: () => unknown[], extra: T) {
    const p = Promise.resolve(rows());
    return { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p), ...extra };
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

  /** `WHERE clause LIMIT n` over the grants table — named to keep the select
   * chain shallow rather than nesting another arrow inside `selectFromTable`. */
  function whereGrants(all: () => Row[], clause: Clause) {
    const filtered = () => all().filter((row) => matches(row, clause));
    return thenable(filtered, { limit: (n: number) => Promise.resolve(filtered().slice(0, n)) });
  }

  function selectFromTable(table: { __table?: string }) {
    if (table.__table !== 'grants') {
      return thenable(() => [], { where: () => ({ limit: () => Promise.resolve([]) }) });
    }
    const all = () => [...grantStore.values()];
    return thenable(all, { where: (clause: Clause) => whereGrants(all, clause) });
  }

  return {
    db: {
      insert: (table: { __table?: string }) => ({
        values: (data: Row) => {
          if (table.__table === 'grants') {
            grantStore.set(String(data.id), data);
          }
          return thenable(() => [], { onConflictDoUpdate: () => Promise.resolve([]) });
        },
      }),
      update: () => ({
        set: (patch: Row) => ({
          where: () => {
            const touched: Row[] = [];
            for (const [id, row] of grantStore) {
              if (row.status === 'active') {
                const next = { ...row, ...patch };
                grantStore.set(id, next);
                touched.push(next);
              }
            }
            return thenable(() => [], { returning: () => Promise.resolve(touched) });
          },
        }),
      }),
      select: () => ({ from: selectFromTable }),
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

import { sealAndStore, sealAndStoreV2, deleteFromVault } from '../index.js';
import { vaultFieldStatus } from '../field-status.js';
import { _resetSealingCache, getNodeSigningIdentity } from '../sealing.js';

const OWNER_DID = 'did:imajin:field-status-owner';

function activeGrant(): Row | undefined {
  return [...grantStore.values()].find((r) => r.status === 'active');
}

/** Move the current grant out of `active`, as expiry/revocation does. */
function lapseCurrentGrant(): void {
  const grant = activeGrant()!;
  grantStore.set(String(grant.id), { ...grant, status: 'expired', wrappedKey: '', wrappedNonce: '' });
}

/** Corrupt the signature of the latest persisted entry for a field. */
async function corruptLatestEntry(field: string): Promise<void> {
  const raw = await readFile(tmpVaultPath, 'utf8');
  const vault = JSON.parse(raw) as { version: number; entries: VaultEntry[] };
  for (let index = vault.entries.length - 1; index >= 0; index -= 1) {
    if (vault.entries[index]!.field === field) {
      vault.entries[index]!.signature = 'a'.repeat(128);
      break;
    }
  }
  await writeFile(tmpVaultPath, JSON.stringify(vault), 'utf8');
}

beforeEach(() => {
  grantStore.clear();
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

describe('vaultFieldStatus', () => {
  it('is absent for a field that was never sealed', async () => {
    expect(await vaultFieldStatus(`never-sealed:${OWNER_DID}`)).toBe('absent');
  });

  it('is absent for a tombstoned field', async () => {
    const field = `v1-field:${OWNER_DID}`;
    await sealAndStore(field, 'plaintext');
    await deleteFromVault(field);
    expect(await vaultFieldStatus(field)).toBe('absent');
  });

  it('is ready for a v1 node-sealed entry', async () => {
    const field = `v1-field:${OWNER_DID}`;
    await sealAndStore(field, 'plaintext');
    expect(await vaultFieldStatus(field)).toBe('ready');
  });

  it('is unverifiable for a corrupted entry rather than throwing', async () => {
    const field = `v1-field:${OWNER_DID}`;
    await sealAndStore(field, 'plaintext');
    await corruptLatestEntry(field);
    expect(await vaultFieldStatus(field)).toBe('unverifiable');
  });

  it('is ready for a v2 entry in Tier 0 (self-grant written at seal time)', async () => {
    const field = `v2-field:${OWNER_DID}`;
    await sealAndStoreV2(field, 'plaintext');
    expect(await vaultFieldStatus(field)).toBe('ready');
  });

  it('is pending-grant for a v2 entry sealed under Tier 1, before the owner responds', async () => {
    process.env.VAULT_OWNER_X_PUB = 'a'.repeat(64);
    process.env.VAULT_OWNER_ED_PUB = 'b'.repeat(64);
    const field = `v2-field:${OWNER_DID}`;

    const result = await sealAndStoreV2(field, 'plaintext');
    expect(result.grantId).toBeNull();
    // Structurally impossible in Tier 0 — this is the state that has no
    // equivalent there, which is why it never needed a name before #1521.
    expect(await vaultFieldStatus(field)).toBe('pending-grant');
  });

  it('is pending-grant once an active grant lapses (mirrors #1535 renewal lockout)', async () => {
    const field = `v2-field:${OWNER_DID}`;
    await sealAndStoreV2(field, 'plaintext');
    expect(await vaultFieldStatus(field)).toBe('ready');

    lapseCurrentGrant();

    expect(await vaultFieldStatus(field)).toBe('pending-grant');
  });

  // #1724: a disconnect revokes the grant (status = 'revoked') rather than
  // letting it lapse via expiry. The status query filters on `status = 'active'`
  // (see field-status.ts), so a revoked row must stop counting as ready just
  // like an expired one does — this is what the connector status check was
  // missing before the fix (it checked vault-entry existence instead).
  it('is not ready once the active grant is explicitly revoked, not merely expired', async () => {
    const field = `v2-field:${OWNER_DID}`;
    await sealAndStoreV2(field, 'plaintext');
    expect(await vaultFieldStatus(field)).toBe('ready');

    const grant = activeGrant()!;
    grantStore.set(String(grant.id), { ...grant, status: 'revoked', wrappedKey: '', wrappedNonce: '' });

    expect(await vaultFieldStatus(field)).not.toBe('ready');
  });

  // #1774: in Tier 0 the requesting node is its own owner agent — self-grant is
  // synchronous at seal time, so there is no external approval to wait on. A
  // Tier 0 field whose grant was explicitly revoked (disconnect) is simply no
  // longer connected, not "pending" one. Before this fix, disconnecting a sealed
  // connector key left the connector card permanently stuck showing "Waiting
  // for owner approval" with no approve/reject/cancel action to resolve it.
  it('is absent, not pending-grant, once a Tier 0 grant is explicitly revoked (disconnect)', async () => {
    const field = `v2-field:${OWNER_DID}`;
    await sealAndStoreV2(field, 'plaintext');
    expect(await vaultFieldStatus(field)).toBe('ready');

    const grant = activeGrant()!;
    grantStore.set(String(grant.id), { ...grant, status: 'revoked', wrappedKey: '', wrappedNonce: '' });

    expect(await vaultFieldStatus(field)).toBe('absent');
  });

  // Tier 1 has a real external owner agent, so a revoked grant there still
  // means "ask the owner agent again" rather than "not connected" — the Tier 0
  // short-circuit above must not apply.
  it('remains pending-grant for a Tier 1 field even after its grant is revoked', async () => {
    process.env.VAULT_OWNER_X_PUB = 'a'.repeat(64);
    process.env.VAULT_OWNER_ED_PUB = 'b'.repeat(64);
    const field = `v2-field:${OWNER_DID}`;

    // Writes the entry; under Tier 1 this queues a request rather than
    // self-granting.
    await sealAndStoreV2(field, 'plaintext');

    // Simulate the owner agent having granted it at some point, then that
    // grant being revoked — `vaultFieldStatus` checks the grant against the
    // NODE's own signing DID, not an arbitrary owner label.
    grantStore.set('vdg_tier1', {
      id: 'vdg_tier1',
      grantedTo: getNodeSigningIdentity().senderDid,
      field,
      status: 'active',
      expiresAt: null,
    });
    grantStore.set('vdg_tier1', { ...grantStore.get('vdg_tier1')!, status: 'revoked' });

    expect(await vaultFieldStatus(field)).toBe('pending-grant');
  });
});
