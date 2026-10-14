import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  keySealedMock: vi.fn(),
  resolveActiveGrantMock: vi.fn(),
  errorLogMock: vi.fn(),
  statusMock: vi.fn(),
  unsealMock: vi.fn(),
}));
vi.mock('@/src/lib/vault', () => ({
  vaultFieldStatus: h.statusMock,
  loadAndUnseal: h.unsealMock,
}));

vi.mock('@/src/lib/stripe/connector-core', () => ({
  stripe: { keySealed: h.keySealedMock, resolveActiveGrant: h.resolveActiveGrantMock },
  stripeEventsScope: 'stripe:events',
  stripePublishableKeyField: (did: string) => `stripe-publishable-key:${did}`,
  stripeWebhookSecretField: (did: string) => `stripe-webhook-secret:${did}`,
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
  h.statusMock.mockReset().mockResolvedValue('ready');
  h.unsealMock.mockReset();
});

describe('resolveCardRail (#2757: the connector is the only card rail)', () => {
  it('is the connector rail only with ready sealed credentials AND the stripe:events grant', async () => {
    h.keySealedMock.mockResolvedValue(true);
    h.resolveActiveGrantMock.mockResolvedValue(true);

    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'connector', ownerDid: SELLER });
    expect(h.keySealedMock).toHaveBeenCalledWith(SELLER);
    expect(h.resolveActiveGrantMock).toHaveBeenCalledWith(SELLER, 'stripe:events');
    expect(h.statusMock.mock.calls).toEqual([
      [`stripe-publishable-key:${SELLER}`],
      [`stripe-webhook-secret:${SELLER}`],
    ]);
    expect(h.unsealMock).not.toHaveBeenCalled();
  });

  it.each([
    ['stripe-publishable-key', 'absent'],
    ['stripe-publishable-key', 'pending-grant'],
    ['stripe-publishable-key', 'unverifiable'],
    ['stripe-webhook-secret', 'absent'],
    ['stripe-webhook-secret', 'pending-grant'],
    ['stripe-webhook-secret', 'unverifiable'],
  ])('offers no card rail with %s %s, even when rk and events grant are ready', async (prefix, status) => {
    h.keySealedMock.mockResolvedValue(true);
    h.resolveActiveGrantMock.mockResolvedValue(true);
    h.statusMock.mockImplementation(async (field: string) => field.startsWith(prefix) ? status : 'ready');
    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'none' });
    expect(h.unsealMock).not.toHaveBeenCalled();
  });

  it('rechecks metadata after webhook secret revocation instead of caching readiness', async () => {
    h.keySealedMock.mockResolvedValue(true);
    h.resolveActiveGrantMock.mockResolvedValue(true);
    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'connector', ownerDid: SELLER });
    h.statusMock.mockImplementation(async (field: string) => field.startsWith('stripe-webhook-secret:') ? 'absent' : 'ready');
    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'none' });
    expect(h.unsealMock).not.toHaveBeenCalled();
  });

  it('fails closed on metadata lookup errors without unsealing credentials', async () => {
    h.keySealedMock.mockResolvedValue(true);
    h.resolveActiveGrantMock.mockResolvedValue(true);
    h.statusMock.mockRejectedValue(new Error('metadata unavailable'));
    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'none' });
    expect(h.unsealMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no sealed key (never connected, or disconnected)', false, true],
    ['a key but no stripe:events grant — it could charge but never settle', true, false],
    ['neither', false, false],
  ])('is NO card rail with %s', async (_label, sealed, granted) => {
    h.keySealedMock.mockResolvedValue(sealed);
    h.resolveActiveGrantMock.mockResolvedValue(granted);

    expect(await resolveCardRail(SELLER)).toEqual({ kind: 'none' });
    expect(h.statusMock).not.toHaveBeenCalled();
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
