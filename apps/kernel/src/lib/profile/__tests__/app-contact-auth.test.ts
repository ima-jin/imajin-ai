import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  strict: vi.fn(), verify: vi.fn(), select: vi.fn(), grant: vi.fn(),
}));
vi.mock('@/src/lib/auth/jwt', () => ({
  verifyAppServiceToken: h.strict,
  verifyAppToken: h.verify,
}));
vi.mock('@/src/lib/auth/app-authorization-grant', () => ({ hasAppAuthorizationGrant: h.grant }));
vi.mock('@/src/db', () => ({
  db: { select: h.select },
  registryApps: { appDid: 'registry.appDid', status: 'registry.status', approvedServiceScopes: 'registry.approved' },
  transactions: { appDid: 'pay.appDid', fromDid: 'pay.fromDid', status: 'pay.status' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
}));

import { authenticateContactApp, relatedContactDids } from '../app-contact-auth';
import { serviceEligibleScopes, scopeEntry } from '@imajin/auth/scope-vocabulary';

const APP = 'did:imajin:events';
const PERSON = 'did:imajin:buyer';
const READ = 'profile:email:read';
const WRITE = 'profile:contact:backfill';
const where = vi.fn();
const request = (headers = { authorization: 'Bearer fixed.test.fixture' }) =>
  ({ headers: new Headers(headers) }) as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.strict.mockResolvedValue({ appDid: APP, scopes: [READ, WRITE] });
  h.verify.mockResolvedValue({ isServiceToken: true, azp: APP, scope: `${READ} ${WRITE}` });
  const result = [{ status: 'active', approved: [READ, WRITE] }];
  where.mockReturnValue({ limit: async () => result });
  h.select.mockReturnValue({ from: () => ({ where }) });
  h.grant.mockResolvedValue(false);
});

describe('contact service scope authentication', () => {
  it.each([READ, WRITE] as const)('accepts %s with strict JWT and live operator approval', async (scope) => {
    await expect(authenticateContactApp(request(), scope)).resolves.toEqual({ appDid: APP });
    expect(h.strict).toHaveBeenCalledWith('fixed.test.fixture');
    expect(where).toHaveBeenCalledWith({ eq: ['registry.appDid', APP] });
  });

  it.each(['missing', 'expired', 'wrong-typ', 'wrong-audience', 'wrong-subject'])('refuses a %s credential', async () => {
    h.strict.mockResolvedValue(null);
    expect(await authenticateContactApp(request(), READ)).toMatchObject({ status: 401 });
    expect(h.select).not.toHaveBeenCalled();
  });

  it('rejects a header-only caller', async () => {
    h.strict.mockResolvedValue(null);
    expect(await authenticateContactApp(request({ authorization: '' }), READ)).toMatchObject({ status: 401 });
    expect(h.strict).toHaveBeenCalledWith('');
  });

  it('rejects a token lacking the explicit email scope before querying registration', async () => {
    h.verify.mockResolvedValue({ isServiceToken: true, azp: APP, scope: 'profile:read' });
    expect(await authenticateContactApp(request(), READ)).toMatchObject({ status: 403 });
    expect(h.select).not.toHaveBeenCalled();
  });

  it.each([
    { rows: [] },
    { rows: [{ status: 'revoked', approved: [READ] }] },
    { rows: [{ status: 'active', approved: [] }] },
    { rows: [{ status: 'active', approved: null }] },
  ])('denies inactive/unknown apps or revoked approval with a still-valid JWT: %j', async ({ rows }) => {
    where.mockReturnValue({ limit: async () => rows });
    expect(await authenticateContactApp(request(), READ)).toMatchObject({ status: 403 });
  });

  it('does not make either personal-data scope self-request service-eligible', () => {
    for (const scope of [READ, WRITE]) {
      expect(scopeEntry(scope)).toBeDefined();
      expect(serviceEligibleScopes()).not.toContain(scope);
    }
  });
});

describe('per-person relationship boundary', () => {
  it('accepts only exact app-bound completed payments and only requested payer DIDs', async () => {
    where.mockResolvedValue([{ did: PERSON }]);
    expect(await relatedContactDids(APP, [PERSON, 'did:imajin:other'], READ)).toEqual([PERSON]);
    expect(where).toHaveBeenCalledWith({ and: [
      { eq: ['pay.appDid', APP] },
      { eq: ['pay.status', 'completed'] },
      { inArray: ['pay.fromDid', [PERSON, 'did:imajin:other']] },
    ] });
    expect(h.grant).toHaveBeenCalledWith(APP, 'did:imajin:other', READ);
  });

  it('accepts an active exact person/app/scope grant when no payment qualifies', async () => {
    where.mockResolvedValue([]);
    h.grant.mockImplementation(async (app, did, scope) => app === APP && did === PERSON && scope === WRITE);
    expect(await relatedContactDids(APP, [PERSON], WRITE)).toEqual([PERSON]);
    expect(await relatedContactDids('did:imajin:other-app', [PERSON], WRITE)).toEqual([]);
    expect(await relatedContactDids(APP, [PERSON], READ)).toEqual([]);
  });

  it('denies absent or revoked relationships rather than trusting an arbitrary app', async () => {
    where.mockResolvedValue([]);
    expect(await relatedContactDids(APP, [PERSON], READ)).toEqual([]);
  });

  it('returns no subjects for an empty request without a lookup', async () => {
    expect(await relatedContactDids(APP, [], READ)).toEqual([]);
    expect(h.select).not.toHaveBeenCalled();
  });

  it('propagates authorization storage errors before disclosure', async () => {
    where.mockRejectedValue(new Error('db down'));
    await expect(relatedContactDids(APP, [PERSON], READ)).rejects.toThrow('db down');
  });
});
