import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({ values: vi.fn(), set: vi.fn(), where: vi.fn(), returning: vi.fn(), limit: vi.fn() }));
vi.mock('@/src/db', async () => {
  const { appAuthorizationCodes } = await import('@/src/db/schemas/app-authorization-codes');
  return {
    appAuthorizationCodes,
    db: {
      insert: () => ({ values: h.values }),
      update: () => ({ set: h.set }),
      select: () => ({ from: () => ({ where: () => ({ limit: h.limit }) }) }),
    },
  };
});
import { consumeAppAuthorizationCode, issueAppAuthorizationCode } from '../app-authorization-code';

const binding = {
  appDid: 'did:imajin:app', subjectDid: 'did:imajin:person',
  attestationId: 'att_unit', callbackUrl: 'https://app.test', state: 's'.repeat(64),
};
beforeEach(() => {
  vi.clearAllMocks();
  h.set.mockReturnValue({ where: h.where });
  h.where.mockReturnValue({ returning: h.returning });
  h.returning.mockResolvedValue([]);
  h.limit.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('app authorization codes', () => {
  it('issues independent 256-bit values, storing only SHA-256 and a 60-second deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    const first = await issueAppAuthorizationCode(binding);
    const second = await issueAppAuthorizationCode(binding);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    const stored = h.values.mock.calls[0][0];
    expect(stored).toEqual({
      ...binding, codeHash: createHash('sha256').update(first).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(JSON.stringify(stored)).not.toContain(first);
  });

  it('atomically updates only an unconsumed, unexpired code for the exact app, callback and state', async () => {
    h.returning.mockResolvedValue([{ ...binding }]);
    const code = await issueAppAuthorizationCode(binding);
    const result = await consumeAppAuthorizationCode({ ...binding, code });
    expect(result).toEqual({ authorization: binding });
    const query = new PgDialect().sqlToQuery(h.where.mock.calls[0][0]);
    expect(query.sql).toContain('"auth"."app_authorization_codes"."consumed_at" is null');
    expect(query.sql).toContain('"auth"."app_authorization_codes"."expires_at" > now()');
    for (const column of ['code_hash', 'app_did', 'callback_url', 'state']) {
      expect(query.sql).toContain(`"auth"."app_authorization_codes"."${column}" =`);
    }
    expect(query.params).toEqual([
      createHash('sha256').update(code).digest('hex'), binding.appDid, binding.callbackUrl, binding.state,
    ]);
    expect(h.returning).toHaveBeenCalledOnce();
    expect(h.limit).not.toHaveBeenCalled();
  });

  it.each([null, new Date()])('distinguishes a used code without returning authorization', async consumedAt => {
    h.limit.mockResolvedValue([{ consumedAt }]);
    expect(await consumeAppAuthorizationCode({ ...binding, code: 'opaque' })).toEqual({
      error: consumedAt ? 'code_used' : 'code_invalid',
    });
  });

  it('returns no authorization for an absent, expired or differently bound code', async () => {
    expect(await consumeAppAuthorizationCode({ ...binding, code: 'opaque' })).toEqual({ error: 'code_invalid' });
  });
});
