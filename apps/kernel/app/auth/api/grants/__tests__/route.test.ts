/**
 * Tests for POST/GET /auth/api/grants (#1882) — user-push-only issuance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, issueGrantMock, listGrantsForDelegatorMock, recordIntroAttributionTermsMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  issueGrantMock: vi.fn(),
  listGrantsForDelegatorMock: vi.fn(),
  recordIntroAttributionTermsMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error, onboarding: 'https://imajin.ai/.well-known/agent.json' }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
  agentCardUrl: () => 'https://imajin.ai/.well-known/agent.json',
}));
vi.mock('@/src/lib/auth/grants', () => ({
  issueGrant: issueGrantMock,
  listGrantsForDelegator: listGrantsForDelegatorMock,
}));
vi.mock('@/src/lib/fair/intro-attribution', () => ({
  recordIntroAttributionTerms: recordIntroAttributionTermsMock,
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

describe('POST /auth/api/grants — intro-attribution terms (#1886)', () => {
  it('does not attempt to record terms when introAttributionTerms is omitted', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    issueGrantMock.mockResolvedValue({ grant: { grantId: 'grant_1' } });

    const res = await POST(makeRequest('POST', { agentDid: AGENT, capabilities: ['intros:propose'], audience: { type: 'all' } }));

    expect(res.status).toBe(201);
    expect(recordIntroAttributionTermsMock).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ grant: { grantId: 'grant_1' } });
  });

  it('rejects a malformed split before issuing the grant', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });

    const res = await POST(
      makeRequest('POST', {
        agentDid: AGENT,
        capabilities: ['intros:propose'],
        audience: { type: 'all' },
        introAttributionTerms: { split: { matchmakerBps: 5000, partyABps: 1000, partyBBps: 1000 } },
      }),
    );

    expect(res.status).toBe(400);
    expect(issueGrantMock).not.toHaveBeenCalled();
    expect(recordIntroAttributionTermsMock).not.toHaveBeenCalled();
  });

  it('records declared terms after a successful grant when intros:propose is present', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    issueGrantMock.mockResolvedValue({ grant: { grantId: 'grant_1' } });
    recordIntroAttributionTermsMock.mockResolvedValue({
      terms: { id: 'iat_1', grantId: 'grant_1', split: { matchmakerBps: 7000, partyABps: 1500, partyBBps: 1500 } },
    });

    const res = await POST(
      makeRequest('POST', {
        agentDid: AGENT,
        capabilities: ['intros:propose'],
        audience: { type: 'all' },
        introAttributionTerms: { attributionWindowDays: 365 },
      }),
    );

    expect(res.status).toBe(201);
    expect(recordIntroAttributionTermsMock).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'grant_1', delegatorDid: DELEGATOR, attributionWindowDays: 365 }),
    );
    const body = await res.json();
    expect(body.introAttributionTerms).toEqual({ id: 'iat_1', grantId: 'grant_1', split: { matchmakerBps: 7000, partyABps: 1500, partyBBps: 1500 } });
  });

  it('ignores introAttributionTerms when the grant does not carry intros:propose', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    issueGrantMock.mockResolvedValue({ grant: { grantId: 'grant_1' } });

    const res = await POST(
      makeRequest('POST', {
        agentDid: AGENT,
        capabilities: ['messages:write'],
        audience: { type: 'all' },
        introAttributionTerms: { attributionWindowDays: 365 },
      }),
    );

    expect(res.status).toBe(201);
    expect(recordIntroAttributionTermsMock).not.toHaveBeenCalled();
  });

  it('surfaces a lib-level terms error with its own status code', async () => {
    requireAuthMock.mockResolvedValue({ identity: { id: DELEGATOR } });
    issueGrantMock.mockResolvedValue({ grant: { grantId: 'grant_1' } });
    recordIntroAttributionTermsMock.mockResolvedValue({ error: 'Intro-attribution terms are already declared for this grant', status: 409 });

    const res = await POST(
      makeRequest('POST', {
        agentDid: AGENT,
        capabilities: ['intros:propose'],
        audience: { type: 'all' },
        introAttributionTerms: {},
      }),
    );

    expect(res.status).toBe(409);
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

  it('propagates an unauthenticated caller', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await GET(makeRequest('GET'));

    expect(res.status).toBe(401);
    expect(listGrantsForDelegatorMock).not.toHaveBeenCalled();
  });
});
