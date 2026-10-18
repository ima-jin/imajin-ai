import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  strict: vi.fn(), verify: vi.fn(), select: vi.fn(),
}));
vi.mock('@/src/lib/auth/jwt', () => ({
  verifyAppServiceToken: h.strict,
  verifyAppToken: h.verify,
}));
vi.mock('@/src/lib/auth/app-authorization-grant', () => ({ APP_AUTHORIZATION_CHANNEL: 'app' }));
vi.mock('@/src/db', () => ({
  db: { select: h.select },
  registryApps: { appDid: 'registry.appDid', status: 'registry.status', approvedServiceScopes: 'registry.approved' },
  transactions: { appDid: 'pay.appDid', fromDid: 'pay.fromDid', status: 'pay.status' },
  channelLinks: {
    channel: 'links.channel', appDid: 'links.appDid', status: 'links.status',
    did: 'links.did', scopes: 'links.scopes',
  },
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
    where.mockResolvedValueOnce([{ did: PERSON }]).mockResolvedValueOnce([]);
    expect(await relatedContactDids(APP, [PERSON, 'did:imajin:other'], READ)).toEqual([PERSON]);
    expect(where).toHaveBeenCalledWith({ and: [
      { eq: ['pay.appDid', APP] },
      { eq: ['pay.status', 'completed'] },
      { inArray: ['pay.fromDid', [PERSON, 'did:imajin:other']] },
    ] });
    expect(where).toHaveBeenLastCalledWith({ and: [
      { eq: ['links.channel', 'app'] },
      { eq: ['links.appDid', APP] },
      { eq: ['links.status', 'active'] },
      { inArray: ['links.did', ['did:imajin:other']] },
    ] });
  });

  it('accepts an active exact person/app/scope grant when no payment qualifies', async () => {
    where.mockResolvedValueOnce([]).mockResolvedValueOnce([{ did: PERSON, scopes: [WRITE] }]);
    expect(await relatedContactDids(APP, [PERSON], WRITE)).toEqual([PERSON]);
  });

  it.each([
    { scopes: [] }, { scopes: null }, { scopes: READ }, { scopes: { [READ]: true } },
    { scopes: [WRITE] }, { scopes: [`${READ}:extra`] },
  ])(
    'rejects missing, malformed or non-exact scopes: %j', async ({ scopes }) => {
      where.mockResolvedValueOnce([]).mockResolvedValueOnce([{ did: PERSON, scopes }]);
      expect(await relatedContactDids(APP, [PERSON], READ)).toEqual([]);
    },
  );

  it('uses one payment query and one grant query for 200 requested DIDs', async () => {
    const dids = Array.from({ length: 200 }, (_, index) => `did:imajin:person-${index}`);
    where.mockResolvedValueOnce([]).mockResolvedValueOnce(dids.map((did) => ({ did, scopes: [READ] })));
    expect(await relatedContactDids(APP, dids, READ)).toEqual(dids);
    expect(h.select).toHaveBeenCalledTimes(2);
    expect(where).toHaveBeenLastCalledWith({ and: [
      { eq: ['links.channel', 'app'] },
      { eq: ['links.appDid', APP] },
      { eq: ['links.status', 'active'] },
      { inArray: ['links.did', dids] },
    ] });
  });

  it('preserves request order and duplicates while fencing out unrequested grants', async () => {
    where.mockResolvedValueOnce([{ did: PERSON }]).mockResolvedValueOnce([
      { did: 'did:imajin:unrequested', scopes: [READ] },
      { did: 'did:imajin:second', scopes: [READ] },
      { did: 'did:imajin:first', scopes: [READ] },
    ]);
    const dids = ['did:imajin:first', PERSON, 'did:imajin:denied', 'did:imajin:second', PERSON];
    expect(await relatedContactDids(APP, dids, READ)).toEqual([
      'did:imajin:first', PERSON, 'did:imajin:second', PERSON,
    ]);
  });

  it('skips grant storage when all requested DIDs have completed payments', async () => {
    where.mockResolvedValueOnce([{ did: PERSON }]);
    expect(await relatedContactDids(APP, [PERSON], READ)).toEqual([PERSON]);
    expect(h.select).toHaveBeenCalledTimes(1);
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

  it('propagates grant storage errors even when another requested DID has paid', async () => {
    where.mockResolvedValueOnce([{ did: PERSON }]).mockRejectedValueOnce(new Error('grant db down'));
    await expect(relatedContactDids(APP, [PERSON, 'did:imajin:other'], READ)).rejects.toThrow('grant db down');
  });
});
