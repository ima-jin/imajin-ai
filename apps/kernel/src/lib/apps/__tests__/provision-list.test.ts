/**
 * Unit tests for `listSucceededAppProvisions` (#2745): the server read behind
 * /jin's provisioned-apps list — succeeded rows only, each flagged `claimed`
 * from the redeemed signing-key claims.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectQueue, whereCalls } = vi.hoisted(() => ({
  selectQueue: [] as Array<Array<Record<string, unknown>>>,
  whereCalls: [] as unknown[],
}));

vi.mock('drizzle-orm', () => ({
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  asc: (col: unknown) => ({ op: 'asc', col }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
}));

vi.mock('@/src/db', () => {
  const chain = () => {
    const rows = selectQueue.shift() ?? [];
    const builder = {
      from: () => builder,
      where: (cond: unknown) => {
        whereCalls.push(cond);
        return builder;
      },
      orderBy: () => Promise.resolve(rows),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return builder;
  };
  return {
    db: { select: () => chain() },
    appProvisions: { slug: 'slug', status: 'status' },
    appSigningKeyClaims: { appDid: 'appDid', status: 'status' },
  };
});

import { listSucceededAppProvisions } from '../provision-list';

const T1 = new Date('2026-10-09T10:00:00.000Z');
const T2 = new Date('2026-10-01T10:00:00.000Z');

beforeEach(() => {
  selectQueue.length = 0;
  whereCalls.length = 0;
});

describe('listSucceededAppProvisions', () => {
  it('queries only succeeded provisions', async () => {
    selectQueue.push([]);

    await listSucceededAppProvisions();

    expect(whereCalls[0]).toMatchObject({ op: 'eq', col: 'status', val: 'succeeded' });
  });

  it('returns an empty list without a claims lookup when nothing has succeeded', async () => {
    selectQueue.push([]);

    await expect(listSucceededAppProvisions()).resolves.toEqual([]);
    expect(whereCalls).toHaveLength(1);
  });

  it('flags apps with a redeemed claim as claimed and the rest as unclaimed', async () => {
    selectQueue.push(
      [
        { slug: 'dykil', appDid: 'did:imajin:app-dykil', repoUrl: 'https://github.com/ima-jin/dykil', updatedAt: T2 },
        { slug: 'learn', appDid: 'did:imajin:app-learn', repoUrl: 'https://github.com/ima-jin/learn', updatedAt: T1 },
      ],
      [{ appDid: 'did:imajin:app-dykil' }],
    );

    const result = await listSucceededAppProvisions();

    expect(result).toEqual([
      { slug: 'dykil', appDid: 'did:imajin:app-dykil', repoUrl: 'https://github.com/ima-jin/dykil', claimed: true, updatedAt: T2 },
      { slug: 'learn', appDid: 'did:imajin:app-learn', repoUrl: 'https://github.com/ima-jin/learn', claimed: false, updatedAt: T1 },
    ]);
    // The claims lookup is scoped to claimed rows of exactly these apps.
    expect(whereCalls[1]).toMatchObject({
      op: 'and',
      conds: [
        { op: 'inArray', col: 'appDid', vals: ['did:imajin:app-dykil', 'did:imajin:app-learn'] },
        { op: 'eq', col: 'status', val: 'claimed' },
      ],
    });
  });

  it('never marks a row without an appDid as claimed, and skips it in the claims lookup', async () => {
    selectQueue.push(
      [
        { slug: 'legacy', appDid: null, repoUrl: null, updatedAt: T2 },
        { slug: 'learn', appDid: 'did:imajin:app-learn', repoUrl: null, updatedAt: T1 },
      ],
      [],
    );

    const result = await listSucceededAppProvisions();

    expect(result.map((row) => [row.slug, row.claimed])).toEqual([
      ['legacy', false],
      ['learn', false],
    ]);
    expect(whereCalls[1]).toMatchObject({ conds: [{ op: 'inArray', vals: ['did:imajin:app-learn'] }, expect.anything()] });
  });

  it('skips the claims lookup when no succeeded row has an appDid', async () => {
    selectQueue.push([{ slug: 'legacy', appDid: null, repoUrl: null, updatedAt: T2 }]);

    const result = await listSucceededAppProvisions();

    expect(result).toHaveLength(1);
    expect(whereCalls).toHaveLength(1);
  });
});
