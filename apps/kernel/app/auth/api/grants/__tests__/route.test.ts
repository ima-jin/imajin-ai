/**
 * Tests for POST/GET /auth/api/grants (#1882) — user-push-only issuance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, issueGrantMock, listGrantsForDelegatorMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  issueGrantMock: vi.fn(),
  listGrantsForDelegatorMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/src/lib/auth/grants', () => ({
  issueGrant: issueGrantMock,
  listGrantsForDelegator: listGrantsForDelegatorMock,
}));

import { POST, GET } from '../route';

const DELEGATOR = 'did:imajin:ryan';
const AGENT = 'did:imajin:matchmaker-agent';
const ENDPOINT = 'http://localhost:3000/auth/api/grants';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(method: string, body?: unknown): RouteRequest {
  return new Request(ENDPOINT, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /auth/api/grants — user-push-only issuance', () => {
  it('rejects a caller acting under X-Acting-For agent delegation', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: DELEGATOR } });

    const res = await POST(makeRequest('POST', { agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } }));

    expect(res.status).toBe(403);
    expect(issueGrantMock).not.toHaveBeenCalled();
  });

  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await POST(makeRequest('POST', { agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } }));

    expect(res.status).toBe(401);
    expect(issueGrantMock).not.toHaveBeenCalled();
  });

  it('issues using the directly authenticated identity as delegatorDid', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    issueGrantMock.mockResolvedValue({ grant: { grantId: 'grant_1' } });

    const res = await POST(makeRequest('POST', { agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } }));

    expect(res.status).toBe(201);
    expect(issueGrantMock).toHaveBeenCalledWith(expect.objectContaining({ delegatorDid: DELEGATOR, agentDid: AGENT }));
  });

  it('sources delegatorDid from actingAs (group impersonation by an authorized controller, distinct from agent bootstrap)', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: 'did:imajin:admin', actingAs: 'did:imajin:group' } });
    issueGrantMock.mockResolvedValue({ grant: { grantId: 'grant_1' } });

    await POST(makeRequest('POST', { agentDid: AGENT, capabilities: ['messages:write'], audience: { type: 'all' } }));

    expect(issueGrantMock).toHaveBeenCalledWith(expect.objectContaining({ delegatorDid: 'did:imajin:group' }));
  });

  it('rejects a request missing agentDid', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });

    const res = await POST(makeRequest('POST', { capabilities: ['messages:write'], audience: { type: 'all' } }));

    expect(res.status).toBe(400);
    expect(issueGrantMock).not.toHaveBeenCalled();
  });

  it('surfaces a lib-level validation error with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    issueGrantMock.mockResolvedValue({ error: 'Unknown capabilities: bogus:scope', status: 400 });

    const res = await POST(makeRequest('POST', { agentDid: AGENT, capabilities: ['bogus:scope'], audience: { type: 'all' } }));

    expect(res.status).toBe(400);
  });
});

describe('GET /auth/api/grants', () => {
  it('lists grants for the authenticated delegator', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    listGrantsForDelegatorMock.mockResolvedValue([{ grantId: 'grant_1' }]);

    const res = await GET(makeRequest('GET'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grants: [{ grantId: 'grant_1' }] });
    expect(listGrantsForDelegatorMock).toHaveBeenCalledWith(DELEGATOR);
  });
});
