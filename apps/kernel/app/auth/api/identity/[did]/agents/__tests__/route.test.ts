/**
 * #2407 — GET /auth/api/identity/:did/agents (principal -> serving agents +
 * connection state). The authority half is the point: only the principal may
 * read it, and an `actor/agent` session — alone or acting for the principal —
 * must not be able to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: class extends Response {
    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
      });
    }
  },
}));

const { mockRequireAuth, mockResolveServingAgents } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockResolveServingAgents: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  agentCardUrl: () => 'https://imajin.ai/.well-known/agent.json',
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), {
      status: authError.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/auth/agent-service', () => ({ resolveServingAgents: mockResolveServingAgents }));

import { GET, OPTIONS } from '../route';

const RYAN = 'did:imajin:ryan';
const MOOI = 'did:imajin:mooi-community';
const JIN = 'did:imajin:jin';
const OTHER = 'did:imajin:someone-else';

const AGENTS = [
  {
    did: JIN,
    handle: 'veteze-jin',
    name: 'Jin',
    servingSince: '2026-09-01T00:00:00.000Z',
    scope: 'actor',
    subtype: 'agent',
    connection: { state: 'connected' },
  },
];

function request(did: string): Request {
  return new Request(`https://test.imajin.ai/auth/api/identity/${encodeURIComponent(did)}/agents`);
}

function params(did: string) {
  return { params: Promise.resolve({ did }) };
}

async function call(did: string) {
  return GET(request(did) as never, params(did));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveServingAgents.mockResolvedValue(AGENTS);
});

describe('GET /auth/api/identity/:did/agents', () => {
  it('returns the principal its serving agents and their connection state', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: RYAN } });

    const res = await call(RYAN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principal: RYAN, agents: AGENTS });
    expect(mockResolveServingAgents).toHaveBeenCalledWith(RYAN);
  });

  it('decodes a percent-encoded DID in the path', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: RYAN } });

    const res = await call(encodeURIComponent(RYAN));

    expect(res.status).toBe(200);
    expect(mockResolveServingAgents).toHaveBeenCalledWith(RYAN);
  });

  it('lets a group operator read the group principal via X-Acting-As', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: RYAN, actingAs: MOOI } });

    const res = await call(MOOI);

    expect(res.status).toBe(200);
    expect(mockResolveServingAgents).toHaveBeenCalledWith(MOOI);
  });

  it('answers an empty list for a principal with no agents', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: RYAN } });
    mockResolveServingAgents.mockResolvedValue([]);

    const res = await call(RYAN);

    expect(await res.json()).toEqual({ principal: RYAN, agents: [] });
  });

  it('propagates an unauthenticated caller and resolves nothing', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const res = await call(RYAN);

    expect(res.status).toBe(401);
    expect(mockResolveServingAgents).not.toHaveBeenCalled();
  });

  describe('authority', () => {
    it("refuses a third party reading someone else's serving agents", async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: OTHER } });

      const res = await call(RYAN);

      expect(res.status).toBe(403);
      expect(mockResolveServingAgents).not.toHaveBeenCalled();
    });

    it('refuses an actor/agent session reading a principal it serves', async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: JIN, scope: 'actor', subtype: 'agent' } });

      const res = await call(RYAN);

      expect(res.status).toBe(403);
      expect(mockResolveServingAgents).not.toHaveBeenCalled();
    });

    it('refuses an actor/agent acting for the principal via X-Acting-For — delegation does not enumerate the principal\'s agents', async () => {
      mockRequireAuth.mockResolvedValue({
        identity: { id: JIN, scope: 'actor', subtype: 'agent', actingFor: RYAN, actingForRole: 'agent' },
      });

      const res = await call(RYAN);

      expect(res.status).toBe(403);
      expect(mockResolveServingAgents).not.toHaveBeenCalled();
    });

    it('refuses X-Acting-For even when the requested DID is the agent itself', async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: JIN, actingFor: RYAN, actingForRole: 'agent' } });

      const res = await call(JIN);

      expect(res.status).toBe(403);
      expect(mockResolveServingAgents).not.toHaveBeenCalled();
    });

    it('refuses a group operator asking for their personal DID while acting as the group', async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: RYAN, actingAs: MOOI } });

      const res = await call(RYAN);

      expect(res.status).toBe(403);
      expect(mockResolveServingAgents).not.toHaveBeenCalled();
    });

    it("only ever reads the caller's own list — an agent session sees the agents serving the agent, nothing more", async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: JIN, scope: 'actor', subtype: 'agent' } });
      mockResolveServingAgents.mockResolvedValue([]);

      const res = await call(JIN);

      expect(res.status).toBe(200);
      expect(mockResolveServingAgents).toHaveBeenCalledTimes(1);
      expect(mockResolveServingAgents).toHaveBeenCalledWith(JIN);
    });
  });

  it('answers 500 without leaking internals when resolution fails', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: RYAN } });
    mockResolveServingAgents.mockRejectedValue(new Error('db down: password=hunter2'));

    const res = await call(RYAN);

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('hunter2');
  });
});

describe('OPTIONS /auth/api/identity/:did/agents', () => {
  it('answers the CORS preflight', async () => {
    const res = await OPTIONS(request(RYAN) as never);

    expect(res.status).toBe(204);
  });
});
