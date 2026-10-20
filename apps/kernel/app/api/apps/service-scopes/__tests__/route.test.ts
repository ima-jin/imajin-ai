/**
 * Unit tests for `POST`/`GET /api/apps/service-scopes` (#2711) — the propose
 * route for operator-approved per-app service scopes. It only ever stages a
 * card; nothing here can widen a service token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER = 'did:imajin:owner';
const OPERATOR = 'did:imajin:operator';
const APP_DID = 'did:imajin:CtdP4azTs7d7avoPorZSs9DMJyGkbnw8xRU8cEsooZQU';

const {
  requireAuthMock,
  getOperatorDidMock,
  recordApprovalRequestedMock,
  findPendingMock,
  selectWhereMock,
  selectLimitMock,
  selectOrderByMock,
  readEventDeclarationsMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  getOperatorDidMock: vi.fn(),
  recordApprovalRequestedMock: vi.fn(),
  findPendingMock: vi.fn(),
  selectWhereMock: vi.fn(),
  selectLimitMock: vi.fn(),
  selectOrderByMock: vi.fn(),
  readEventDeclarationsMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: requireAuthMock };
});

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  gt: (...args: unknown[]) => ({ gt: args }),
  asc: (...args: unknown[]) => ({ asc: args }),
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: selectWhereMock }) }) },
  registryApps: {},
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_testid` }));

vi.mock('@/src/lib/notify/operator-approvals', () => ({
  getOperatorDid: getOperatorDidMock,
  isOperatorIdentity: (identity: { id: string; actingFor?: string }, operatorDid: string) =>
    identity.id === operatorDid && !identity.actingFor,
  computeApprovalContentHash: () => 'h'.repeat(64),
}));

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  recordApprovalRequested: recordApprovalRequestedMock,
}));

vi.mock('@/src/lib/apps/approvals-execution', () => ({ APPS_SOURCE: 'apps' }));
vi.mock('@/src/lib/apps/event-declarations', () => ({ readEventDeclarations: readEventDeclarationsMock }));

// Pure helpers are re-declared so this test never loads the DB-backed module.
vi.mock('@/src/lib/apps/service-scopes', () => {
  const normalizeScopes = (scopes: string[]) => [...new Set(scopes)].sort((a, b) => a.localeCompare(b));
  return {
    MAX_SERVICE_SCOPES_PER_PROPOSAL: 20,
    normalizeScopes,
    parseScopeList: (value: unknown) =>
      Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0) ? normalizeScopes(value) : null,
    findPendingServiceScopesProposal: findPendingMock,
  };
});

import { POST, GET } from '../route';
const get = (qs: string) => new Request(`https://kernel.test/api/apps/service-scopes${qs}`);

function post(body: unknown): Request {
  return new Request('https://kernel.test/api/apps/service-scopes', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

}

function app(overrides: Record<string, unknown> = {}) {
  return { name: 'Tripian', ownerDid: OWNER, status: 'active', approved: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ identity: { id: OWNER, scope: 'actor', subtype: 'human' } });
  getOperatorDidMock.mockResolvedValue(OPERATOR);
  findPendingMock.mockResolvedValue(undefined);
  recordApprovalRequestedMock.mockResolvedValue(undefined);
  selectWhereMock.mockResolvedValue([app()]);
  selectOrderByMock.mockReturnValue({ limit: selectLimitMock });
  selectLimitMock.mockResolvedValue([]);
  readEventDeclarationsMock.mockResolvedValue({ declaredEmittableEvents: ['tip.requested'] });
});

describe('POST /api/apps/service-scopes', () => {
  it('stages an operator-approvals card for the owner and returns pending, without touching the app', async () => {
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write', 'identity:read'] }) as never);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'pending', proposalId: 'appscope_testid' });
    expect(recordApprovalRequestedMock).toHaveBeenCalledTimes(1);
    const arg = recordApprovalRequestedMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      source: 'apps',
      kind: 'apps:service-scopes',
      operatorDid: OPERATOR,
      signerDid: OWNER,
      summary: `App 'Tripian' (${APP_DID}) requests service scopes [identity:read, identity:write]`,
    });
    expect(arg.detail).toMatchObject({ appDid: APP_DID, action: 'grant', scopes: ['identity:read', 'identity:write'], currentlyApproved: [] });
  });

  it('lets the operator propose for an app they do not own', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OPERATOR, scope: 'actor', subtype: 'human' } });
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(201);
  });

  it('403s a stranger and stages nothing', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:stranger', scope: 'actor', subtype: 'human' } });
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(403);
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('401s when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(401);
  });

  it('404s an unknown app', async () => {
    selectWhereMock.mockResolvedValue([]);
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(404);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['missing appDid', { scopes: ['identity:write'] }],
    ['empty scopes', { appDid: APP_DID, scopes: [] }],
    ['non-string scopes', { appDid: APP_DID, scopes: [1] }],
    ['unknown scope on grant', { appDid: APP_DID, scopes: ['bogus:scope'] }],
    ['bad action', { appDid: APP_DID, scopes: ['identity:write'], action: 'nuke' }],
  ])('400s %s', async (_label, body) => {
    const res = await POST(post(body) as never);
    expect(res.status).toBe(400);
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('409s a grant for a revoked app', async () => {
    selectWhereMock.mockResolvedValue([app({ status: 'revoked' })]);
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(409);
  });

  it('short-circuits when every scope is already approved', async () => {
    selectWhereMock.mockResolvedValue([app({ approved: ['identity:write'] })]);
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(await res.json()).toMatchObject({ status: 'already-approved' });
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('reuses an identical pending proposal instead of raising a duplicate card', async () => {
    findPendingMock.mockResolvedValue({ proposalId: 'appscope_existing' });
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending', proposalId: 'appscope_existing' });
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('500s when no operator is configured', async () => {
    getOperatorDidMock.mockResolvedValue(null);
    // authorizeForApp resolves the owner first, so the owner path still reaches the operator check
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(500);
  });

  it('500s when the card cannot be recorded', async () => {
    recordApprovalRequestedMock.mockRejectedValue(new Error('db down'));
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'] }) as never);
    expect(res.status).toBe(500);
  });

  it('revoke: stages a revoke card for a currently approved scope', async () => {
    selectWhereMock.mockResolvedValue([app({ approved: ['identity:read', 'identity:write'] })]);
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'], action: 'revoke' }) as never);
    expect(res.status).toBe(201);
    const arg = recordApprovalRequestedMock.mock.calls[0][0];
    expect(arg.summary).toContain('loses service scopes [identity:write]');
    expect(arg.detail).toMatchObject({ action: 'revoke', scopes: ['identity:write'] });
  });

  it('revoke: 409s when none of the scopes are approved', async () => {
    const res = await POST(post({ appDid: APP_DID, scopes: ['identity:write'], action: 'revoke' }) as never);
    expect(res.status).toBe(409);
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });


});

describe('GET /api/apps/service-scopes', () => {
  it.each(['', '&includeEvents=false', '&includeEvents=1', '&includeEvents=True'])('keeps the legacy per-app response without explicit opt-in %s', async (query) => {
    selectWhereMock.mockResolvedValue([app({
      appId: 'app_coffee', slug: 'coffee', sourceRepo: null, emittableEvents: ['tip.sent'],
      requested: [], approvalId: null, approvedAt: null,
    })]);
    const response = await GET(get(`?appDid=${APP_DID}${query}`) as never);
    expect(await response.json()).toEqual({
      appDid: APP_DID, requestedScopes: [], approvedServiceScopes: [], approvalId: null, approvedAt: null,
    });
    expect(readEventDeclarationsMock).not.toHaveBeenCalled();
  });

  it.each([OWNER, OPERATOR])('returns flat metadata for an authorized opted-in caller %s, keeping approved and requested distinct', async (id) => {
    requireAuthMock.mockResolvedValue({ identity: { id, scope: 'actor', subtype: 'human' } });
    selectWhereMock.mockResolvedValue([app({
      appId: 'app_coffee', slug: 'coffee', sourceRepo: 'other-owner/coffee',
      requested: ['identity:read'], emittableEvents: ['tip.sent', 'tip.granted', 'tip.sent'],
      approvalId: null, approvedAt: null,
    })]);
    const response = await GET(get(`?appDid=${APP_DID}&includeEvents=true`) as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      appDid: APP_DID, appId: 'app_coffee', requestedScopes: ['identity:read'], approvedServiceScopes: [],
      approvalId: null, approvedAt: null,
      approvedEmittableEvents: ['tip.granted', 'tip.sent'], declaredEmittableEvents: ['tip.requested'],
    });
    expect(readEventDeclarationsMock).toHaveBeenCalledTimes(1);
    expect(readEventDeclarationsMock).toHaveBeenCalledWith({ slug: 'coffee', sourceRepo: 'other-owner/coffee' });
  });

  it.each([{ emittableEvents: [] }, { emittableEvents: null }, { emittableEvents: 'invalid' }])('returns an empty approved set independently of the manifest: %j', async ({ emittableEvents }) => {
    selectWhereMock.mockResolvedValue([app({ appId: 'app_coffee', slug: 'coffee', sourceRepo: null, emittableEvents })]);
    const response = await GET(get(`?appDid=${APP_DID}&includeEvents=true`) as never);
    expect(await response.json()).toMatchObject({ approvedEmittableEvents: [], declaredEmittableEvents: ['tip.requested'] });
  });

  it.each([
    { declaredEmittableEvents: [] },
    { declaredEmittableEvents: null, eventDeclarationError: 'App manifest could not be read' },
    { declaredEmittableEvents: null, eventDeclarationError: 'App manifest event declarations are invalid' },
  ])('preserves existing approvals for empty/unavailable declarations: %j', async (declarations) => {
    selectWhereMock.mockResolvedValue([app({ appId: 'app_coffee', slug: null, sourceRepo: null, emittableEvents: ['tip.sent'] })]);
    readEventDeclarationsMock.mockResolvedValue(declarations);
    const response = await GET(get(`?appDid=${APP_DID}&includeEvents=true`) as never);
    expect(await response.json()).toMatchObject({ approvedEmittableEvents: ['tip.sent'], ...declarations });
  });

  it('refuses unauthorized, unknown, and unauthenticated opt-in reads before manifest access', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:stranger', scope: 'actor', subtype: 'human' } });
    expect((await GET(get(`?appDid=${APP_DID}&includeEvents=true`) as never)).status).toBe(403);
    selectWhereMock.mockResolvedValue([]);
    expect((await GET(get(`?appDid=${APP_DID}&includeEvents=true`) as never)).status).toBe(404);
    requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await GET(get(`?appDid=${APP_DID}&includeEvents=true`) as never)).status).toBe(401);
    expect(readEventDeclarationsMock).not.toHaveBeenCalled();
  });
  function asOperator() {
    requireAuthMock.mockResolvedValue({ identity: { id: OPERATOR, scope: 'actor', subtype: 'human' } });
    selectWhereMock.mockReturnValue({ orderBy: selectOrderByMock });
  }

  it('discovers self-registered apps with normalized scopes and no secret fields', async () => {
    asOperator();
    selectLimitMock.mockResolvedValue([{
      appDid: APP_DID, name: 'Tripian', status: 'active',
      requested: ['identity:write', 'identity:read', 'identity:read'],
      approved: null, approvalId: null, approvedAt: null,
    }]);
    const res = await GET(get('?includeEvents=true') as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ apps: [{
      appDid: APP_DID, name: 'Tripian', status: 'active',
      requestedScopes: ['identity:read', 'identity:write'],
      approvedServiceScopes: [], approvalId: null, approvedAt: null,
    }], nextCursor: null });
    expect(selectLimitMock).toHaveBeenCalledWith(51);
    expect(readEventDeclarationsMock).not.toHaveBeenCalled();
  });

  it('bounds discovery and resumes after the last returned DID', async () => {
    asOperator();
    selectLimitMock.mockResolvedValue(Array.from({ length: 51 }, (_, n) => ({
      appDid: `did:imajin:app-${String(n).padStart(3, '0')}`,
      name: `App ${n}`, status: 'active', requested: [], approved: [], approvalId: null, approvedAt: null,
    })));
    const first = await (await GET(get('') as never)).json();
    expect(first.apps).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    selectLimitMock.mockResolvedValue([]);
    const next = await GET(get(`?cursor=${encodeURIComponent(first.nextCursor)}`) as never);
    expect(await next.json()).toEqual({ apps: [], nextCursor: null });
    expect(selectWhereMock).toHaveBeenLastCalledWith({ gt: [undefined, first.apps[49].appDid] });
  });

  it.each(['', 'not-a-cursor', Buffer.from(JSON.stringify(123)).toString('base64url')])('rejects malformed discovery cursor %j', async (cursor) => {
    asOperator();
    expect((await GET(get(`?cursor=${cursor}`) as never)).status).toBe(400);
    expect(selectLimitMock).not.toHaveBeenCalled();
  });

  it.each([
    { id: OWNER, scope: 'actor', subtype: 'human' },
    { id: OPERATOR, scope: 'actor', subtype: 'human', actingFor: OWNER },
    { id: OPERATOR, scope: 'actor', subtype: 'human', actingAs: OWNER, actingAsRole: 'owner' },
  ])('rejects non-operator discovery before querying registry', async (identity) => {
    requireAuthMock.mockResolvedValue({ identity });
    expect((await GET(get('') as never)).status).toBe(403);
    expect(selectWhereMock).not.toHaveBeenCalled();
  });

  it('fails explicitly rather than representing a failed registry read as an empty list', async () => {
    asOperator();
    selectLimitMock.mockRejectedValue(new Error('database unavailable'));
    const res = await GET(get('') as never);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('lets the operator read platform-owned requested scopes', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: OPERATOR, scope: 'actor', subtype: 'human' } });
    selectWhereMock.mockResolvedValue([app({ ownerDid: 'did:imajin:platform', requested: ['pay:settle'] })]);
    const res = await GET(get(`?appDid=${APP_DID}`) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requestedScopes: ['pay:settle'], approvedServiceScopes: [] });
  });

  it.each([null, undefined, 'invalid', [1]])('uses empty scopes for malformed registry value %j', async (requested) => {
    selectWhereMock.mockResolvedValue([app({ requested })]);
    const res = await GET(get(`?appDid=${APP_DID}`) as never);
    expect(await res.json()).toMatchObject({ requestedScopes: [] });
  });

  it('returns normalized requested and approved sets + last approval for the owner', async () => {
    selectWhereMock.mockResolvedValue([
      { ownerDid: OWNER, requested: ['pay:settle', 'identity:read', 'pay:settle'], approved: ['identity:write', 'identity:read'], approvalId: 'appscope_1', approvedAt: '2026-10-07T14:00:00.000Z' },
    ]);
    const res = await GET(get(`?appDid=${APP_DID}`) as never);
    expect(await res.json()).toEqual({
      appDid: APP_DID,
      requestedScopes: ['identity:read', 'pay:settle'],
      approvedServiceScopes: ['identity:read', 'identity:write'],
      approvalId: 'appscope_1',
      approvedAt: '2026-10-07T14:00:00.000Z',
    });
  });

  it('403s discovery for an owner, 404s an unknown app, 403s a stranger, 401s unauthenticated', async () => {
    expect((await GET(get('') as never)).status).toBe(403);

    selectWhereMock.mockResolvedValue([]);
    expect((await GET(get(`?appDid=${APP_DID}`) as never)).status).toBe(404);

    selectWhereMock.mockResolvedValue([{ ownerDid: 'did:imajin:someone-else', approved: [], approvalId: null, approvedAt: null }]);
    expect((await GET(get(`?appDid=${APP_DID}`) as never)).status).toBe(403);

    requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await GET(get(`?appDid=${APP_DID}`) as never)).status).toBe(401);
  });
});
