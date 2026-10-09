import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  keySealedMock: vi.fn(),
  resolveActiveGrantMock: vi.fn(),
  connectRows: [] as Array<Record<string, unknown>>,
  connectWhereMock: vi.fn(),
  resolveConnectedAccountFeeMock: vi.fn(),
  errorLogMock: vi.fn(),
  connectLimit: async () => h.connectRows,
  connectWhere: (condition: unknown) => {
    h.connectWhereMock(condition);
    return { limit: h.connectLimit };
  },
}));

vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripe: { keySealed: h.keySealedMock, resolveActiveGrant: h.resolveActiveGrantMock },
  STRIPE_EVENTS_SCOPE: 'stripe:events',
}));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: h.connectWhere }) }) },
  connectedAccounts: { did: 'did', chargesEnabled: 'chargesEnabled', stripeAccountId: 'stripeAccountId' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));
vi.mock('../../checkout', () => ({ resolveConnectedAccountFee: h.resolveConnectedAccountFeeMock }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.errorLogMock }),
}));

import { resolveCardRail, resolveConnectCheckout } from '../card-rail';

const ISSUER = 'did:imajin:imajin-inc';

beforeEach(() => {
  h.keySealedMock.mockReset().mockResolvedValue(false);
  h.resolveActiveGrantMock.mockReset().mockResolvedValue(false);
  h.connectRows.length = 0;
  h.connectWhereMock.mockReset();
  h.resolveConnectedAccountFeeMock.mockReset();
  h.errorLogMock.mockReset();
});

describe('resolveCardRail', () => {
  it('connector first: a readable sealed key AND the stripe:events grant', async () => {
    h.keySealedMock.mockResolvedValue(true);
    h.resolveActiveGrantMock.mockResolvedValue(true);

    expect(await resolveCardRail(ISSUER)).toEqual({ kind: 'connector', ownerDid: ISSUER });
    expect(h.keySealedMock).toHaveBeenCalledWith(ISSUER);
    expect(h.resolveActiveGrantMock).toHaveBeenCalledWith(ISSUER, 'stripe:events');
  });

  it('the connector wins even when a Connect account also exists — Connect is only a fallback', async () => {
    h.keySealedMock.mockResolvedValue(true);
    h.resolveActiveGrantMock.mockResolvedValue(true);
    h.connectRows.push({ id: 'acct_1' });

    expect((await resolveCardRail(ISSUER)).kind).toBe('connector');
    expect(h.connectWhereMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no sealed key (never connected, or disconnected)', false, true],
    ['a key but no stripe:events grant — it could charge but never settle', true, false],
  ])('is NOT a connector rail with %s', async (_label, sealed, granted) => {
    h.keySealedMock.mockResolvedValue(sealed);
    h.resolveActiveGrantMock.mockResolvedValue(granted);

    expect(await resolveCardRail(ISSUER)).toEqual({ kind: 'none' });
  });

  it('falls back to Connect when there is no connector and the account is charge-enabled', async () => {
    h.connectRows.push({ id: 'acct_1' });

    expect(await resolveCardRail(ISSUER)).toEqual({ kind: 'connect' });
    // The lookup is for THIS issuer's charge-enabled account.
    expect(h.connectWhereMock).toHaveBeenCalledWith({
      and: [{ eq: ['did', ISSUER] }, { eq: ['chargesEnabled', true] }],
    });
  });

  it('neither rail = none (no card button)', async () => {
    expect(await resolveCardRail(ISSUER)).toEqual({ kind: 'none' });
  });

  it('a connector lookup failure is logged and reads as unavailable — it falls through to Connect instead of throwing', async () => {
    h.keySealedMock.mockRejectedValue(new Error('db down'));
    h.connectRows.push({ id: 'acct_1' });

    expect(await resolveCardRail(ISSUER)).toEqual({ kind: 'connect' });
    expect(h.errorLogMock).toHaveBeenCalledWith(expect.objectContaining({ issuerDid: ISSUER }), expect.stringContaining('connector lookup failed'));
  });

  it('with both lookups failing it still resolves — to none — so the pay page renders', async () => {
    h.keySealedMock.mockRejectedValue(new Error('db down'));
    h.connectWhereMock.mockImplementation(() => {
      throw new Error('db down');
    });

    expect(await resolveCardRail(ISSUER)).toEqual({ kind: 'none' });
    expect(h.errorLogMock).toHaveBeenCalledTimes(2);
  });
});

describe('resolveConnectCheckout (#2757 deletes this)', () => {
  it('is exactly the pre-#2754 Connect destination + fee computation', async () => {
    const body = { items: [], currency: 'CAD', successUrl: '', cancelUrl: '', sellerDid: ISSUER };
    h.resolveConnectedAccountFeeMock.mockResolvedValue({ ok: true, connectedAccountId: 'acct_1', applicationFeeAmount: 200 });

    expect(await resolveConnectCheckout(body)).toEqual({ ok: true, connectedAccountId: 'acct_1', applicationFeeAmount: 200 });
    expect(h.resolveConnectedAccountFeeMock).toHaveBeenCalledWith(body);
  });
});
