import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  keySealedMock: vi.fn(),
  resolveActiveGrantMock: vi.fn(),
  errorLogMock: vi.fn(),
}));

vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripe: { keySealed: h.keySealedMock, resolveActiveGrant: h.resolveActiveGrantMock },
  STRIPE_EVENTS_SCOPE: 'stripe:events',
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: h.errorLogMock }),
}));

import { resolveCardRail, SELLER_NO_CARD_RAIL } from '../card-rail';

const SELLER = 'did:imajin:imajin-inc';

beforeEach(() => {
  h.keySealedMock.mockReset().mockResolvedValue(false);
  h.resolveActiveGrantMock.mockReset().mockResolvedValue(false);
  h.errorLogMock.mockReset();
});

describe('resolveCardRail (#2757: the connector is the only card rail)', () => {
  it('is the connector rail with a readable sealed key AND the stripe:events grant', async () => {
    h.keySealedMock.mockResolvedValue(true);
    h.resolveActiveGrantMock.mockResolvedValue(true);

    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'connector', ownerDid: SELLER });
    expect(h.keySealedMock).toHaveBeenCalledWith(SELLER);
    expect(h.resolveActiveGrantMock).toHaveBeenCalledWith(SELLER, 'stripe:events');
  });

  it.each([
    ['no sealed key (never connected, or disconnected)', false, true],
    ['a key but no stripe:events grant — it could charge but never settle', true, false],
    ['neither', false, false],
  ])('is NO card rail with %s', async (_label, sealed, granted) => {
    h.keySealedMock.mockResolvedValue(sealed);
    h.resolveActiveGrantMock.mockResolvedValue(granted);

    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'none' });
  });

  it('a lookup failure is logged and reads as unavailable — it resolves to none instead of throwing', async () => {
    h.keySealedMock.mockRejectedValue(new Error('db down'));

    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'none' });
    expect(h.errorLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ sellerDid: SELLER }),
      expect.stringContaining('connector lookup failed'),
    );
  });
});

describe('SELLER_NO_CARD_RAIL', () => {
  it('is the stable code callers surface when a seller has no card rail', () => {
    expect(SELLER_NO_CARD_RAIL).toBe('SELLER_NO_CARD_RAIL');
  });
});
