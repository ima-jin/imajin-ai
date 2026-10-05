/**
 * #2407 — GET /auth/api/identity/:did resolves an `actor/agent` with its
 * `serviceOf` relation, disclosed only to the parties to that relation.
 * Everything the endpoint returned before (publicKey/scope/subtype/tier/
 * dfosDid) stays public and unchanged.
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

const { mockSelectLimit, mockOptionalAuth, mockListServiceOf, mockGetChain } = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockOptionalAuth: vi.fn(),
  mockListServiceOf: vi.fn(),
  mockGetChain: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mockSelectLimit }) }) }) },
  identities: {},
}));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));
vi.mock('@imajin/auth', () => ({ optionalAuth: mockOptionalAuth }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/auth/dfos', () => ({ getChainByImajinDid: mockGetChain }));
vi.mock('@/src/lib/auth/agent-service', () => ({
  AGENT_SCOPE: 'actor',
  AGENT_SUBTYPE: 'agent',
  listServiceOf: mockListServiceOf,
}));

import { GET } from '../route';

const RYAN = 'did:imajin:ryan';
const MOOI = 'did:imajin:mooi-community';
const JIN = 'did:imajin:jin';
const OTHER_AGENT = 'did:imajin:other-agent';
const STRANGER = 'did:imajin:stranger';

const AGENT_ROW = { id: JIN, publicKey: 'aa'.repeat(32), scope: 'actor', subtype: 'agent', tier: 'preliminary' };
const HUMAN_ROW = { id: RYAN, publicKey: 'bb'.repeat(32), scope: 'actor', subtype: 'human', tier: 'established' };

function call(did: string) {
  return GET(new Request(`https://test.imajin.ai/auth/api/identity/${did}`) as never, {
    params: Promise.resolve({ did }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([AGENT_ROW]);
  mockGetChain.mockResolvedValue(null);
  mockOptionalAuth.mockResolvedValue(null);
  mockListServiceOf.mockResolvedValue([RYAN, MOOI]);
});

describe('GET /auth/api/identity/:did — actor/agent resolution', () => {
  it('resolves the agent DID as actor/agent with its public fields', async () => {
    mockOptionalAuth.mockResolvedValue({ id: STRANGER });

    const body = await (await call(JIN)).json();

    expect(body).toMatchObject({ did: JIN, scope: 'actor', subtype: 'agent', tier: 'preliminary' });
  });

  it('gives the agent itself its full serviceOf', async () => {
    mockOptionalAuth.mockResolvedValue({ id: JIN });

    const body = await (await call(JIN)).json();

    expect(body.serviceOf).toEqual([RYAN, MOOI]);
  });

  it('gives a served principal serviceOf narrowed to itself — never the agent\'s other principals', async () => {
    mockOptionalAuth.mockResolvedValue({ id: RYAN });

    const body = await (await call(JIN)).json();

    expect(body.serviceOf).toEqual([RYAN]);
  });

  it('gives a group operator acting as the served group serviceOf narrowed to that group', async () => {
    mockOptionalAuth.mockResolvedValue({ id: RYAN, actingAs: MOOI });

    const body = await (await call(JIN)).json();

    expect(body.serviceOf).toEqual([RYAN, MOOI]);
  });

  it('keeps the field present-but-empty for an agent that serves nobody yet', async () => {
    mockOptionalAuth.mockResolvedValue({ id: JIN });
    mockListServiceOf.mockResolvedValue([]);

    const body = await (await call(JIN)).json();

    expect(body.serviceOf).toEqual([]);
  });

  describe('disclosure (serviceOf names a principal)', () => {
    it('omits serviceOf for an anonymous caller, without even querying it', async () => {
      const body = await (await call(JIN)).json();

      expect(body).not.toHaveProperty('serviceOf');
      expect(mockListServiceOf).not.toHaveBeenCalled();
    });

    it('omits serviceOf for an authenticated third party', async () => {
      mockOptionalAuth.mockResolvedValue({ id: STRANGER });

      expect(await (await call(JIN)).json()).not.toHaveProperty('serviceOf');
    });

    it("omits serviceOf for a different agent, even one acting for the served principal via X-Acting-For", async () => {
      mockOptionalAuth.mockResolvedValue({ id: OTHER_AGENT, actingFor: RYAN, actingForRole: 'agent' });

      expect(await (await call(JIN)).json()).not.toHaveProperty('serviceOf');
    });

    it('omits serviceOf when the lookup fails, but still resolves the identity publicly', async () => {
      mockOptionalAuth.mockResolvedValue({ id: JIN });
      mockListServiceOf.mockRejectedValue(new Error('db down'));

      const res = await call(JIN);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ did: JIN, subtype: 'agent' });
      expect(body).not.toHaveProperty('serviceOf');
    });

    it('omits serviceOf when authentication itself throws', async () => {
      mockOptionalAuth.mockRejectedValue(new Error('session service down'));

      const res = await call(JIN);

      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('serviceOf');
    });
  });
});

describe('GET /auth/api/identity/:did — non-agent identities are unchanged', () => {
  it('never evaluates serviceOf for a human DID, even for the DID itself', async () => {
    mockSelectLimit.mockResolvedValue([HUMAN_ROW]);
    mockOptionalAuth.mockResolvedValue({ id: RYAN });

    const body = await (await call(RYAN)).json();

    expect(body).toEqual({ did: RYAN, publicKey: HUMAN_ROW.publicKey, scope: 'actor', subtype: 'human', tier: 'established' });
    expect(mockOptionalAuth).not.toHaveBeenCalled();
    expect(mockListServiceOf).not.toHaveBeenCalled();
  });

  it('does not treat subtype=agent outside scope=actor as an agent', async () => {
    mockSelectLimit.mockResolvedValue([{ ...AGENT_ROW, scope: 'business' }]);
    mockOptionalAuth.mockResolvedValue({ id: JIN });

    expect(await (await call(JIN)).json()).not.toHaveProperty('serviceOf');
    expect(mockListServiceOf).not.toHaveBeenCalled();
  });

  it('keeps including dfosDid when a chain exists', async () => {
    mockSelectLimit.mockResolvedValue([HUMAN_ROW]);
    mockGetChain.mockResolvedValue({ dfosDid: 'did:dfos:abc' });

    expect((await (await call(RYAN)).json()).dfosDid).toBe('did:dfos:abc');
  });

  it('answers 404 for an unknown DID', async () => {
    mockSelectLimit.mockResolvedValue([]);

    expect((await call('did:imajin:nobody')).status).toBe(404);
  });

  it('answers 500 when the identity lookup itself fails', async () => {
    mockSelectLimit.mockRejectedValue(new Error('db down'));

    expect((await call(JIN)).status).toBe(500);
  });
});
