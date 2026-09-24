/**
 * Unit tests for `listActiveGrantsForField` (#2298).
 *
 * This is the field-scoped read every "who currently holds this field"
 * surface should use instead of following a single `vault_minted_keys.grantId`
 * — see `key-cards.ts`'s `listVaultKeyCards` and `grants-lane.ts`'s
 * vault-delegation source, both of which reuse it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unlink } from 'node:fs/promises';

interface GrantRow {
  id: string;
  field: string;
  grantedTo: string;
  status: string;
  createdAt: Date;
}

const { tmpVaultPath, grantStore } = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-list-active-grants-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  return { tmpVaultPath, grantStore: new Map<string, GrantRow>() };
});

type Predicate = (row: GrantRow) => boolean;

vi.mock('drizzle-orm', () => ({
  and: (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row)),
  eq: (column: string, value: unknown): Predicate => (row) => (row as unknown as Record<string, unknown>)[column] === value,
  desc: (_col: unknown) => ({ __desc: true }),
}));

function queryActiveGrants(predicate: Predicate): Promise<GrantRow[]> {
  return Promise.resolve(
    [...grantStore.values()].filter(predicate).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  );
}

function whereClause(predicate: Predicate) {
  return { orderBy: () => queryActiveGrants(predicate) };
}

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = {
    __table: 'grants',
    id: 'id',
    field: 'field',
    grantedTo: 'grantedTo',
    status: 'status',
    createdAt: 'createdAt',
  };
  return {
    db: {
      select: () => ({
        from: (_table: unknown) => ({ where: whereClause }),
      }),
    },
    vaultDelegationGrants,
  };
});

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

import { listActiveGrantsForField } from '../index.js';

const FIELD = 'vault-minted-key:did:imajin:abcdef0123456789';
const OTHER_FIELD = 'vault-minted-key:did:imajin:other';

function grantRow(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    id: 'vdg_1',
    field: FIELD,
    grantedTo: 'did:imajin:consumer1',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  grantStore.clear();
});

afterEach(async () => {
  await unlink(tmpVaultPath).catch(() => undefined);
});

describe('listActiveGrantsForField', () => {
  it('returns an empty array when the field has no grants at all', async () => {
    await expect(listActiveGrantsForField(FIELD)).resolves.toEqual([]);
  });

  it('excludes grants for a different field', async () => {
    grantStore.set('vdg_other', grantRow({ id: 'vdg_other', field: OTHER_FIELD }));

    await expect(listActiveGrantsForField(FIELD)).resolves.toEqual([]);
  });

  it('excludes revoked and superseded grants for the same field', async () => {
    grantStore.set('vdg_revoked', grantRow({ id: 'vdg_revoked', status: 'revoked' }));
    grantStore.set('vdg_superseded', grantRow({ id: 'vdg_superseded', status: 'superseded' }));

    await expect(listActiveGrantsForField(FIELD)).resolves.toEqual([]);
  });

  it('returns every active grant for the field, newest first', async () => {
    grantStore.set('vdg_1', grantRow({ id: 'vdg_1', createdAt: new Date('2026-01-01T00:00:00.000Z') }));
    grantStore.set('vdg_2', grantRow({
      id: 'vdg_2',
      grantedTo: 'did:imajin:consumer2',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    }));

    const result = await listActiveGrantsForField(FIELD);

    expect(result.map((g) => g.id)).toEqual(['vdg_2', 'vdg_1']);
  });

  // The multi-consumer case this function exists for (#2298): a second
  // `grantExistingMintedKey` grant to a DIFFERENT consumer for the SAME
  // field is a distinct active row alongside the original mint-time grant.
  it('surfaces multiple consumers granted access to the same field', async () => {
    grantStore.set('vdg_original', grantRow({ id: 'vdg_original', grantedTo: 'did:imajin:original-consumer' }));
    grantStore.set('vdg_additional', grantRow({
      id: 'vdg_additional',
      grantedTo: 'did:imajin:second-consumer',
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
    }));

    const result = await listActiveGrantsForField(FIELD);

    expect(result).toHaveLength(2);
    expect(result.map((g) => g.grantedTo).sort()).toEqual(['did:imajin:original-consumer', 'did:imajin:second-consumer']);
  });
});
