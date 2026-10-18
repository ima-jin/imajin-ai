import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@imajin/config';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), select: vi.fn(), list: vi.fn(), save: vi.fn(), ready: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/src/db', () => ({
  db: { select: mocks.select },
  identities: { id: 'groupId', scope: 'scope' },
  identityMembers: { identityDid: 'ownerDid', memberDid: 'memberDid', role: 'role', removedAt: 'removedAt' },
  registryApps: { id: 'id', ownerDid: 'ownerDid', appDid: 'appDid', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...conditions: Array<(row: Row) => boolean>) => (row: Row) => conditions.every(check => check(row)),
  eq: (column: string, value: unknown) => (row: Row) => row[column] === value,
  inArray: (column: string, values: unknown[]) => (row: Row) => values.includes(row[column]),
  isNull: (column: string) => (row: Row) => row[column] === null,
}));
vi.mock('@/src/lib/mail/store', () => ({ listSenderConfigs: mocks.list, saveSenderConfig: mocks.save }));
vi.mock('@/src/lib/mail/readiness', () => ({ isDomainMailReady: mocks.ready }));

import { GET, PUT } from '../route';

type Row = Record<string, unknown>;
const ownerDid = 'did:imajin:org';
const caller = 'did:imajin:human';
const context = { params: Promise.resolve({ ownerDid }) };
const valid = { purpose: 'signin', domain: 'example.org', localPart: 'signin', displayName: 'Example' };
let membership: Row;
let app: Row;

function request(body: unknown = valid, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/jin/api/orgs/org/mail-senders', {
    method: 'PUT', headers, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  membership = { ownerDid, memberDid: caller, role: 'owner', removedAt: null, scope: 'business' };
  app = { id: 'app', ownerDid, appDid: 'did:imajin:app', status: 'active' };
  mocks.auth.mockResolvedValue({ identity: { id: caller } });
  mocks.list.mockResolvedValue([]);
  mocks.ready.mockResolvedValue(false);
  mocks.save.mockResolvedValue(undefined);
  mocks.select.mockImplementation(() => {
    let joined = false;
    const chain = {
      from: () => chain,
      innerJoin: () => { joined = true; return chain; },
      where: (predicate: (row: Row) => boolean) => ({
        limit: async () => [joined ? membership : app].filter(predicate),
      }),
    };
    return chain;
  });
});

describe('organization mail settings authority', () => {
  it.each(['owner', 'admin'])('permits an active %s and uses only real caller.id', async role => {
    membership.role = role;
    mocks.auth.mockResolvedValue({ identity: { id: caller, actingAs: 'did:imajin:elsewhere' } });
    expect((await PUT(request(), context)).status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { sessionOnly: true });
    expect(mocks.save).toHaveBeenCalledWith({ ...valid, ownerDid, appDid: '', replyTo: null });
  });

  it.each([
    { ownerDid: 'did:imajin:other-org' },
    { memberDid: 'did:imajin:nonmember' },
    { removedAt: new Date() },
    { role: 'member' },
    { role: 'maintainer' },
    { role: 'agent' },
    { scope: 'actor' },
  ])('denies reads and writes for membership %j', async override => {
    Object.assign(membership, override);
    expect((await GET(request(), context)).status).toBe(403);
    expect((await PUT(request(), context)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('returns authentication errors without querying membership', async () => {
    mocks.auth.mockResolvedValue({ error: 'User session required', status: 401 });
    expect((await GET(request(), context)).status).toBe(401);
    expect((await PUT(request(), context)).status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each(['app+jwt', 'app-service+jwt'])('rejects %s credentials in cookies through real sessionOnly machinery', async typ => {
    const { requireAuth } = await import('../../../../../../../../../packages/auth/src/require-auth');
    mocks.auth.mockImplementation(requireAuth);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const token = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', typ })).toString('base64url')}.payload.signature`;
    expect((await PUT(request(valid, { cookie: `${SESSION_COOKIE_NAME}=${token}` }), context)).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects bearer tokens through real sessionOnly machinery', async () => {
    const { requireAuth } = await import('../../../../../../../../../packages/auth/src/require-auth');
    mocks.auth.mockImplementation(requireAuth);
    expect((await PUT(request(valid, { authorization: 'Bearer app-token' }), context)).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['business', 'community', 'family'])('supports group scope %s', async scope => {
    membership.scope = scope;
    expect((await GET(request(), context)).status).toBe(200);
  });
});

describe('sender validation and persistence', () => {
  it.each(['signin', 'receipts', 'notifications', 'contact'])('accepts fixed purpose %s', async purpose => {
    expect((await PUT(request({ ...valid, purpose }), context)).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ purpose }));
  });
  it.each([
    { purpose: 'marketing' }, { purpose: null }, { mailReady: true }, { ownerDid: 'forged' },
    { domain: 'https://example.org' }, { domain: '127.0.0.1' }, { domain: 'example.org:25' },
    { domain: 'user@example.org' }, { domain: '-bad.org' }, { domain: 'bad-.org' },
    { domain: 'bad..org' }, { domain: 'x'.repeat(64) + '.org' }, { domain: 'localhost' },
    { localPart: 'bad\r\nBcc: victim' }, { localPart: 'a..b' }, { localPart: '.a' },
    { localPart: 'a@b' }, { localPart: 'x'.repeat(65) },
    { displayName: 'Bad\r\nBcc: victim' }, { displayName: '<bad>' }, { displayName: '"' },
    { displayName: '' }, { displayName: 'x'.repeat(101) },
    { replyTo: 'Not an email' }, { replyTo: 'a@example.org\r\nBcc: victim' },
    { appDid: 'arbitrary' }, { appDid: 'x'.repeat(257) },
  ])('rejects invalid or unrecognized input %j', async override => {
    expect((await PUT(request({ ...valid, ...override }), context)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([null, [], 'text'])('rejects non-object JSON %j', async body => {
    expect((await PUT(request(body), context)).status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const req = request();
    vi.spyOn(req, 'json').mockRejectedValue(new SyntaxError());
    expect((await PUT(req, context)).status).toBe(400);
  });

  it('normalizes domains and accepts an owned active app override and reply-to', async () => {
    const body = { ...valid, domain: ' EXAMPLE.ORG ', appDid: app.appDid, replyTo: 'help@example.org' };
    expect((await PUT(request(body), context)).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ ...body, domain: 'example.org', ownerDid });
  });

  it.each([{ ownerDid: 'did:imajin:other' }, { status: 'revoked' }, { appDid: 'did:imajin:different' }])(
    'rejects foreign, missing, or revoked app overrides %j', async override => {
      Object.assign(app, override);
      expect((await PUT(request({ ...valid, appDid: 'did:imajin:app' }), context)).status).toBe(403);
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it('returns senders, fixed defaults and deduplicated server-authoritative readiness privately', async () => {
    mocks.list.mockResolvedValue([{ ...valid, ownerDid, appDid: '', replyTo: null }, { ...valid, purpose: 'receipts' }]);
    const response = await GET(request(), context);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      readiness: { 'example.org': false },
      defaults: { signin: 'Signin <signin@imajin.ai>', contact: 'Imajin <info@imajin.ai>' },
    });
    expect(mocks.ready).toHaveBeenCalledOnce();
    expect(mocks.ready).toHaveBeenCalledWith(ownerDid, 'example.org');
  });

  it('fails closed when database authorization fails', async () => {
    mocks.select.mockImplementation(() => { throw new Error('database details'); });
    expect((await GET(request(), context)).status).toBe(500);
    expect(await (await PUT(request(), context)).json()).toEqual({ error: 'Mail sender settings unavailable' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('handles read, readiness and persistence failures without leaking details', async () => {
    mocks.list.mockRejectedValueOnce(new Error('private'));
    expect((await GET(request(), context)).status).toBe(500);
    mocks.list.mockResolvedValue([{ ...valid }]);
    mocks.ready.mockRejectedValueOnce(new Error('private'));
    expect((await GET(request(), context)).status).toBe(500);
    mocks.save.mockRejectedValueOnce(new Error('private'));
    expect(await (await PUT(request(), context)).json()).toEqual({ error: 'Mail sender settings unavailable' });
  });
});
