/**
 * #2176 — the top-up success page resolves the credited amount by looking the Stripe checkout session
 * id up on `pay.transactions.external_ref` (with the Stripe rail) — never the deprecated `stripe_id`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWhere } from '@/src/lib/pay/__tests__/mock-drizzle-table';

const mocks = vi.hoisted(() => {
  const rows: { value: unknown[] } = { value: [] };
  const limit = vi.fn(async () => rows.value);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { rows, where, select: vi.fn(() => ({ from })), getSession: vi.fn() };
});

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@imajin/auth', () => ({ getSession: mocks.getSession }));
vi.mock('@imajin/config', () => ({ buildPublicUrl: (name: string) => `https://${name}.test` }));
vi.mock('@/src/db', async () => ({
  db: { select: mocks.select },
  transactions: (await import('@/src/db/schemas/pay')).transactions,
}));

import TopupSuccessPage from '../success/page';

/** Flatten a React element tree's text children so the rendered message can be asserted on. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return textOf(props?.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ did: 'did:imajin:buyer' });
  mocks.rows.value = [];
});

describe('top-up success page', () => {
  it('looks the checkout session up by rail + external_ref, never stripe_id, and shows the credited amount', async () => {
    mocks.rows.value = [{ amount: '25.00000000', externalRef: 'cs_topup_1' }];

    const page = await TopupSuccessPage({ searchParams: Promise.resolve({ session_id: 'cs_topup_1' }) });

    const rendered = renderWhere(mocks.where.mock.calls[0][0]);
    expect(rendered.sql).toContain('"external_ref"');
    expect(rendered.sql).not.toContain('stripe_id');
    expect(rendered.params).toEqual(['stripe', 'cs_topup_1']);
    expect(textOf(page)).toContain('$25.00 CAD has been credited to your MJN balance.');
  });

  it('falls back to the generic message when no transaction matches the session id', async () => {
    const page = await TopupSuccessPage({ searchParams: Promise.resolve({ session_id: 'cs_unknown' }) });

    expect(textOf(page)).toContain('Your top-up has been processed successfully.');
  });

  it('does not query at all without a session_id', async () => {
    await TopupSuccessPage({ searchParams: Promise.resolve({}) });

    expect(mocks.select).not.toHaveBeenCalled();
  });
});
