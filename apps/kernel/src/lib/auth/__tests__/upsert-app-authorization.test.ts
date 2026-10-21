import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  execute: vi.fn(), orderBy: vi.fn(), values: vi.fn(),
  revoke: vi.fn(), project: vi.fn(), sign: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('nanoid', () => ({ nanoid: () => 'new-grant' }));
vi.mock('@/src/db', async () => {
  const { attestations } = await import('@/src/db/schemas/auth');
  return { db: { transaction: h.transaction }, attestations };
});
vi.mock('@imajin/auth', () => ({
  canonicalize: JSON.stringify, crypto: { signSync: h.sign },
}));
vi.mock('@/src/lib/auth/revoke-attestation', () => ({ revokeAttestationOnce: h.revoke }));
vi.mock('@/src/lib/auth/app-authorization-grant', () => ({ projectAppAuthorizationGrant: h.project }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { attestations } from '@/src/db/schemas/auth';
import { upsertAppAuthorization, revokeAppAuthorization } from '../upsert-app-authorization';

const consent = {
  ownerDid: 'owner', appDid: 'app', appId: 'app_id',
  callbackUrl: 'https://app.example.test/callback', scopes: ['media:read'], privateKey: 'test-key',
};
const tx = {
  execute: h.execute,
  select: () => ({ from: () => ({ where: () => ({ orderBy: h.orderBy }) }) }),
  insert: (table: unknown) => {
    expect(table).toBe(attestations);
    return { values: h.values };
  },
};
function grant(id: string, scopes: unknown = ['media:read'], extra = {}) {
  return { id, payload: { scopes }, revokedAt: null, expiresAt: null, ...extra };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.orderBy.mockImplementation(async () => h.rows);
  h.transaction.mockImplementation(async (work: (database: typeof tx) => unknown) => work(tx));
  h.revoke.mockResolvedValue({ revoked: true });
  h.project.mockResolvedValue(undefined);
  h.sign.mockReturnValue('signed');
});

describe('shared app consent behavioral seam (#3008)', () => {
  it('takes a pair-scoped transaction advisory lock before reading live grants', async () => {
    await upsertAppAuthorization(consent);
    const query = new PgDialect().sqlToQuery(h.execute.mock.calls[0][0]);
    expect(query.sql).toBe('select pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(query.params).toEqual([JSON.stringify(['app.authorized', 'owner', 'app'])]);
    expect(h.execute.mock.invocationCallOrder[0]).toBeLessThan(h.orderBy.mock.invocationCallOrder[0]);
    const order = h.orderBy.mock.calls[0].map(sql => new PgDialect().sqlToQuery(sql).sql);
    expect(order).toEqual(['"auth"."attestations"."issued_at" desc', '"auth"."attestations"."id" desc']);
    expect(h.transaction).toHaveBeenCalledOnce();
  });

  it('does not mint or project when a live surplus row cannot be revoked', async () => {
    h.rows = [grant('protected', ['profile:read'])];
    h.revoke.mockResolvedValue({ revoked: false });
    await expect(upsertAppAuthorization(consent)).rejects.toThrow('retry consent');
    expect(h.values).not.toHaveBeenCalled();
    expect(h.project).not.toHaveBeenCalled();
  });

  it.each([
    [['media:read', 'profile:read'], ['profile:read', 'media:read']],
    [['media:read', 'media:read'], ['media:read']],
    [['media:read'], ['media:read', 'media:read']],
    [[], []],
  ])('reuses identical scope sets independent of order/duplicates: %j → %j', async (existing, scopes) => {
    h.rows = [grant('newest', existing), grant('surplus', existing)];
    expect(await upsertAppAuthorization({ ...consent, scopes })).toBe('newest');
    expect(h.values).not.toHaveBeenCalled();
    expect(h.revoke).toHaveBeenCalledOnce();
    expect(h.revoke).toHaveBeenCalledWith({
      attestationId: 'surplus', revokedByDid: 'owner', privateKey: 'test-key',
    }, tx);
    expect(h.project).toHaveBeenCalledWith({ ownerDid: 'owner', appDid: 'app', scopes: [...new Set(scopes)] }, tx);
  });

  it('supersedes every live row, not merely the first row, when the newest scopes differ', async () => {
    h.rows = [grant('newest', ['profile:read']), grant('older'), grant('oldest')];
    expect(await upsertAppAuthorization(consent)).toBe('att_new-grant');
    expect(h.revoke.mock.calls.map(([params]) => params.attestationId)).toEqual(['newest', 'older', 'oldest']);
    for (const [, database] of h.revoke.mock.calls) expect(database).toBe(tx);
    expect(h.values).toHaveBeenCalledOnce();
    expect(h.project).toHaveBeenCalledWith({ ownerDid: 'owner', appDid: 'app', scopes: ['media:read'] }, tx);
  });

  it.each([
    { revokedAt: new Date() },
    { expiresAt: new Date(0) },
  ])('does not reuse inactive grants: %j', async (extra) => {
    h.rows = [grant('inactive', ['media:read'], extra)];
    expect(await upsertAppAuthorization(consent)).toBe('att_new-grant');
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it('deduplicates the scopes in the signed new grant and projection', async () => {
    await upsertAppAuthorization({ ...consent, scopes: ['media:read', 'media:read'] });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      issuerDid: 'owner', subjectDid: 'app', type: 'app.authorized', signature: 'signed',
      payload: { scopes: ['media:read'], appId: 'app_id', callbackUrl: consent.callbackUrl },
    }));
    expect(JSON.parse(h.sign.mock.calls[0][0])).toMatchObject({
      type: 'app.authorized', context_id: 'app_id', context_type: 'app',
      subject_did: 'app', payload: { scopes: ['media:read'] },
    });
  });

  it.each(['sign', 'project', 'revoke'] as const)('propagates %s failures out of the transaction', async (seam) => {
    h.rows = [grant('old', ['profile:read'])];
    if (seam === 'sign') h.sign.mockImplementationOnce(() => { throw new Error('failed'); });
    else h[seam].mockRejectedValueOnce(new Error('failed'));
    await expect(upsertAppAuthorization(consent)).rejects.toThrow('failed');
    if (seam === 'revoke') expect(h.values).not.toHaveBeenCalled();
  });
});

describe('survivor-aware explicit revoke', () => {
  const params = { ownerDid: 'owner', appDid: 'app', attestationId: 'surplus', privateKey: 'test-key' };
  it('preserves the newest live survivor projection using the same transaction', async () => {
    h.rows = [grant('expired', [], { expiresAt: new Date(0) }), grant('survivor', ['profile:read'])];
    await revokeAppAuthorization(params);
    expect(h.revoke).toHaveBeenCalledWith({
      attestationId: 'surplus', revokedByDid: 'owner', privateKey: 'test-key',
    }, tx);
    expect(h.project).toHaveBeenCalledWith({ ownerDid: 'owner', appDid: 'app', scopes: ['profile:read'] }, tx);
    expect(h.execute.mock.invocationCallOrder[0]).toBeLessThan(h.revoke.mock.invocationCallOrder[0]);
  });
  it('revokes the projection if no live survivor exists', async () => {
    await revokeAppAuthorization(params);
    expect(h.project).toHaveBeenCalledWith({ ownerDid: 'owner', appDid: 'app', scopes: [] }, tx);
  });
  it('does not read or overwrite projection if CAS lost', async () => {
    h.revoke.mockResolvedValue({ revoked: false });
    expect(await revokeAppAuthorization(params)).toEqual({ revoked: false });
    expect(h.orderBy).not.toHaveBeenCalled();
    expect(h.project).not.toHaveBeenCalled();
  });
});
