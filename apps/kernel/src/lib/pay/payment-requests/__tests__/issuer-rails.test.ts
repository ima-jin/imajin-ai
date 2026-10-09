import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolveCardRailMock: vi.fn(),
  profileRows: [] as Array<Record<string, unknown>>,
  limit: async () => h.profileRows,
  where: () => ({ limit: h.limit }),
}));

vi.mock('../card-rail', () => ({ resolveCardRail: h.resolveCardRailMock }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: h.where }) }) },
  profiles: { did: 'did', etransferEmail: 'etransferEmail' },
}));
vi.mock('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));

import { getIssuerPayRails } from '../issuer-rails';

beforeEach(() => {
  h.resolveCardRailMock.mockReset().mockResolvedValue({ kind: 'none' });
  h.profileRows.length = 0;
});

describe('getIssuerPayRails', () => {
  it.each([
    ['connector', { kind: 'connector', ownerDid: 'did:x' }],
    ['connect', { kind: 'connect' }],
  ])('card is true on the %s rail', async (_label, rail) => {
    h.resolveCardRailMock.mockResolvedValue(rail);

    expect((await getIssuerPayRails('did:x')).card).toBe(true);
  });

  it('card is false with no rail', async () => {
    expect((await getIssuerPayRails('did:x')).card).toBe(false);
  });

  it('emt is true with a receiving email, false when unset, blank, or there is no profile', async () => {
    h.profileRows.push({ etransferEmail: 'pay@acme.example' });
    expect((await getIssuerPayRails('did:x')).emt).toBe(true);

    h.profileRows[0] = { etransferEmail: '   ' };
    expect((await getIssuerPayRails('did:x')).emt).toBe(false);

    h.profileRows[0] = { etransferEmail: null };
    expect((await getIssuerPayRails('did:x')).emt).toBe(false);

    h.profileRows.length = 0;
    expect((await getIssuerPayRails('did:x')).emt).toBe(false);
  });

  it('neither', async () => {
    expect(await getIssuerPayRails('did:x')).toEqual({ card: false, emt: false });
  });
});
