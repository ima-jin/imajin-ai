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
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  getOperatorDidMock: vi.fn(),
  recordApprovalRequestedMock: vi.fn(),
  findPendingMock: vi.fn(),
  selectWhereMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/auth', async () => {
  const actual = await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth');
  return { ...actual, requireAuth: requireAuthMock };
});

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));

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
  const get = (qs: string) => new Request(`https://kernel.test/api/apps/service-scopes${qs}`);

  it('returns the approved set + last approval for the owner', async () => {
    selectWhereMock.mockResolvedValue([
      { ownerDid: OWNER, approved: ['identity:write', 'identity:read'], approvalId: 'appscope_1', approvedAt: '2026-10-07T14:00:00.000Z' },
    ]);
    const res = await GET(get(`?appDid=${APP_DID}`) as never);
    expect(await res.json()).toEqual({
      appDid: APP_DID,
      approvedServiceScopes: ['identity:read', 'identity:write'],
      approvalId: 'appscope_1',
      approvedAt: '2026-10-07T14:00:00.000Z',
    });
  });

  it('400s without appDid, 404s an unknown app, 403s a stranger, 401s unauthenticated', async () => {
    expect((await GET(get('') as never)).status).toBe(400);

    selectWhereMock.mockResolvedValue([]);
    expect((await GET(get(`?appDid=${APP_DID}`) as never)).status).toBe(404);

    selectWhereMock.mockResolvedValue([{ ownerDid: 'did:imajin:someone-else', approved: [], approvalId: null, approvedAt: null }]);
    expect((await GET(get(`?appDid=${APP_DID}`) as never)).status).toBe(403);

    requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await GET(get(`?appDid=${APP_DID}`) as never)).status).toBe(401);
  });
});
