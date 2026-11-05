import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NextRequest } from 'next/server';
import { createFeeCreditHarness, feeMigration } from './fee-credit-harness';
import { forEachSequential } from '@/src/lib/async/sequential';

const state = vi.hoisted(() => ({
  db: undefined as unknown as Awaited<ReturnType<typeof createFeeCreditHarness>>['db'],
  client: undefined as unknown as Awaited<ReturnType<typeof createFeeCreditHarness>>['client'],
  identity: { id: 'did:imajin:person', actingAs: undefined as string | undefined },
  adminTransactionIds: [] as string[],
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/pay'),
  db: { select: (...args: Parameters<typeof state.db.select>) => state.db.select(...args) },
}));
vi.mock('@imajin/auth', () => ({
  getSession: async () => state.identity,
  requireAuth: async () => ({ identity: state.identity }),
  requireAppAuth: vi.fn(),
  resolveActingDid: (identity: typeof state.identity) => identity.actingAs ?? identity.id,
  resolveEffectiveDid: async () => ({ ok: true, effectiveDid: state.identity.actingAs ?? state.identity.id }),
}));
vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `/${slug}` }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@/app/pay/components/BalanceCard', () => ({ BalanceCard: () => null }));
vi.mock('@/app/admin/users/[did]/actions', () => ({ default: () => null }));
vi.mock('@imajin/db', () => ({
  getClient: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((result, part, index) => result + part + (index < values.length ? `$${index + 1}` : ''), '');
    if (text.includes('FROM pay.transactions')) {
      const { rows } = await state.client.query<{ id: string }>(text, values);
      state.adminTransactionIds = rows.map((row) => row.id);
      return rows;
    }
    if (text.includes('FROM auth.identities')) return [{ id: values[0], public_key: null, created_at: null }];
    return [];
  },
}));

import { transactions } from '@/src/db/schemas/pay';
import { GET as listTransactions } from '@/app/pay/api/transactions/[did]/route';
import { GET as summarizeTransactions } from '@/app/pay/api/transactions/[did]/summary/route';
import { buildTransactionConditions } from '@/app/pay/history/helpers';
import Home from '@/app/pay/page';
import AdminUserDetailPage from '@/app/admin/users/[did]/page';

let harness: Awaited<ReturnType<typeof createFeeCreditHarness>>;
beforeAll(async () => {
  harness = await createFeeCreditHarness();
  state.db = harness.db;
  state.client = harness.client;
  await harness.client.exec(feeMigration);
  await forEachSequential(['did:imajin:person', 'did:imajin:org'], async (did) => {
    await state.db.insert(transactions).values([
      { id: `${did}:incoming`, service: 'market', type: 'sale', fromDid: 'did:imajin:other', toDid: did, amount: '10', status: 'completed', sourceKind: 'receipt' },
      { id: `${did}:outgoing`, service: 'market', type: 'purchase', fromDid: did, toDid: 'did:imajin:other', amount: '4', status: 'completed', sourceKind: 'transfer' },
      { id: `${did}:fee-in`, service: 'fee-only', type: 'fee_probe', fromDid: null, toDid: did, amount: '99', status: 'completed', sourceKind: 'fee' },
      { id: `${did}:fee-out`, service: 'fee-only', type: 'fee_probe', fromDid: did, toDid: 'did:imajin:other', amount: '77', status: 'completed', sourceKind: 'fee' },
    ]);
  });
}, 30_000);
afterAll(async () => { await harness?.client.close(); });

describe.each([undefined, 'did:imajin:org'])('fee bookkeeping is not another payment (actingAs=%s)', (actingAs) => {
  it('excludes fee rows from transaction list, earned/spent sums, history, wallet recent rows and admin history', async () => {
    state.identity = { id: 'did:imajin:person', actingAs };
    const did = actingAs ?? state.identity.id;
    const params = { params: Promise.resolve({ did }) };
    const request = new Request(`http://localhost/pay/api/transactions/${did}`) as NextRequest;
    const response = await listTransactions(request, params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.transactions.map((row: { id: string }) => row.id).sort()).toEqual([`${did}:incoming`, `${did}:outgoing`]);

    const summary = await summarizeTransactions(request, params);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toEqual({
      services: { market: { earned: 10, spent: 4, count: 2 } },
      total: { earned: 10, spent: 4, net: 6 },
    });

    const { userTxCondition, conditions } = buildTransactionConditions(did, {});
    const history = await state.db.select().from(transactions).where(and(...conditions));
    expect(history.map((row) => row.id).sort()).toEqual([`${did}:incoming`, `${did}:outgoing`]);
    const services = await state.db.selectDistinct({ service: transactions.service }).from(transactions).where(userTxCondition);
    expect(services).toEqual([{ service: 'market' }]);

    const page = renderToStaticMarkup(await Home());
    expect(page).toContain('sale');
    expect(page).not.toContain('fee probe');

    await AdminUserDetailPage(params);
    expect(state.adminTransactionIds.sort()).toEqual([`${did}:incoming`, `${did}:outgoing`]);
  });
});
