import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  selectWhereNoLimit: vi.fn(),
  insertReturning: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (..._args: unknown[]) => ({
          limit: h.selectLimit,
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: h.insertReturning,
        }),
      }),
    }),
  },
  attestationTypeRegistry: { typeName: 'typeName', revokedAt: 'revokedAt', namespace: 'namespace' },
  identities: { id: 'id', handle: 'handle' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: (...args: unknown[]) => args,
  isNull: vi.fn(),
}));

import { isRegisteredAttestationType, registerAttestationType, resolveHandleForDid } from '../attestation-type-registry';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isRegisteredAttestationType', () => {
  it('is true when a live row exists', async () => {
    h.selectLimit.mockResolvedValue([{ typeName: 'acme/referral_made' }]);
    expect(await isRegisteredAttestationType('acme/referral_made')).toBe(true);
  });

  it('is false when no row exists', async () => {
    h.selectLimit.mockResolvedValue([]);
    expect(await isRegisteredAttestationType('unknown/type')).toBe(false);
  });
});

describe('resolveHandleForDid', () => {
  it('returns the handle when found', async () => {
    h.selectLimit.mockResolvedValue([{ handle: 'acme' }]);
    expect(await resolveHandleForDid('did:imajin:acme-agent')).toBe('acme');
  });

  it('returns null when the identity has no handle', async () => {
    h.selectLimit.mockResolvedValue([{ handle: null }]);
    expect(await resolveHandleForDid('did:imajin:acme-agent')).toBeNull();
  });
});

describe('registerAttestationType', () => {
  const base = { registeredByDid: 'did:imajin:acme-agent', handle: 'acme', localName: 'referral_made' };

  it('rejects the reserved platform namespace', async () => {
    const result = await registerAttestationType({ ...base, handle: 'platform' });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/reserved/) });
  });

  it('rejects an empty handle', async () => {
    const result = await registerAttestationType({ ...base, handle: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid localName', async () => {
    const result = await registerAttestationType({ ...base, localName: 'Not Valid!' });
    expect(result.ok).toBe(false);
  });

  it('rejects a localName already registered and not revoked', async () => {
    h.selectLimit.mockResolvedValue([{ typeName: 'acme/referral_made', revokedAt: null }]);
    const result = await registerAttestationType(base);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/already registered/) });
  });

  it('registers a valid, unclaimed type under the caller namespace', async () => {
    h.selectLimit.mockResolvedValue([]); // no existing row
    h.insertReturning.mockResolvedValue([
      { typeName: 'acme/referral_made', namespace: 'acme', registeredByDid: base.registeredByDid },
    ]);

    const result = await registerAttestationType(base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.typeName).toBe('acme/referral_made');
      expect(result.entry.namespace).toBe('acme');
    }
  });

  it('re-registers a previously revoked type', async () => {
    h.selectLimit.mockResolvedValue([{ typeName: 'acme/referral_made', revokedAt: new Date() }]);
    h.insertReturning.mockResolvedValue([
      { typeName: 'acme/referral_made', namespace: 'acme', registeredByDid: base.registeredByDid },
    ]);

    const result = await registerAttestationType(base);

    expect(result.ok).toBe(true);
  });
});
