import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '@imajin/auth';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn(),
  getBalances: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({
  getSession: mocks.getSession,
  resolveActingDid: (session: Identity) => session.actingFor ?? session.actingAs ?? session.id,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `/${slug}` }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
  transactions: { fromDid: 'fromDid', toDid: 'toDid', createdAt: 'createdAt' },
}));
vi.mock('@/src/lib/pay/ledger', () => ({
  MJN: 'MJN',
  MJNX: 'MJNx',
  getBalances: mocks.getBalances,
  amountOf: () => 0,
}));
vi.mock('../components/BalanceCard', () => ({ BalanceCard: () => null }));
import Home from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redirect.mockImplementation(() => { throw new Error('NEXT_REDIRECT'); });
  mocks.getBalances.mockResolvedValue([]);
  mocks.limit.mockResolvedValue([]);
  mocks.where.mockReturnValue({ orderBy: () => ({ limit: mocks.limit }) });
});

describe('standalone wallet page', () => {
  it('redirects unauthenticated callers to login with a wallet return URL', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(Home()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/login?next=%2Fpay');
    expect(mocks.getBalances).not.toHaveBeenCalled();
  });

  it.each([undefined, 'did:imajin:group'])('loads the validated wallet owner (actingAs=%s)', async (actingAs) => {
    mocks.getSession.mockResolvedValue({ id: 'did:imajin:actor', scope: 'actor', actingAs });
    await Home();
    expect(mocks.getSession).toHaveBeenCalledWith({ service: 'pay' });
    expect(mocks.getBalances).toHaveBeenCalledWith(expect.anything(), actingAs ?? 'did:imajin:actor');
    expect(mocks.where).toHaveBeenCalled();
  });
});
