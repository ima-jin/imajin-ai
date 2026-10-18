import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ update: vi.fn(), select: vi.fn(), transaction: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { transaction: h.transaction },
  identities: { id: 'identity.id', contactEmail: 'identity.email' },
  profiles: { did: 'profile.did', contactEmail: 'profile.email' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (col: unknown) => ({ isNull: col }),
}));
import { backfillContact } from '../backfill-contact';

const DID = 'did:imajin:buyer';
const EMAIL = 'buyer@example.com';
const identityWhere = vi.fn();
const profileWhere = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  h.transaction.mockImplementation(async (fn) => fn({ update: h.update, select: h.select }));
  identityWhere.mockReturnValue({ returning: async () => [{ contactEmail: EMAIL }] });
  profileWhere.mockReturnValue({ returning: async () => [{ did: DID }] });
  h.update.mockImplementation((table) => ({
    set: (value: unknown) => {
      expect(value).toEqual({ contactEmail: EMAIL });
      return { where: 'id' in table ? identityWhere : profileWhere };
    },
  }));
  h.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
});

describe('atomic contact backfill', () => {
  it('guards both independent columns with IS NULL in one transaction', async () => {
    expect(await backfillContact(DID, EMAIL)).toEqual({ did: DID, contactEmail: EMAIL, backfilled: true });
    expect(h.transaction).toHaveBeenCalledOnce();
    expect(identityWhere).toHaveBeenCalledWith({ and: [
      { eq: ['identity.id', DID] }, { isNull: 'identity.email' },
    ] });
    expect(profileWhere).toHaveBeenCalledWith({ and: [
      { eq: ['profile.did', DID] }, { isNull: 'profile.email' },
    ] });
    expect(h.select).not.toHaveBeenCalled();
  });

  it('does not touch a profile for a nonexistent identity', async () => {
    identityWhere.mockReturnValue({ returning: async () => [] });
    expect(await backfillContact(DID, EMAIL)).toBeNull();
    expect(profileWhere).not.toHaveBeenCalled();
  });

  it('propagates a profile write failure so the transaction rolls back', async () => {
    profileWhere.mockImplementation(() => { throw new Error('write failed'); });
    await expect(backfillContact(DID, EMAIL)).rejects.toThrow('write failed');
  });
});
