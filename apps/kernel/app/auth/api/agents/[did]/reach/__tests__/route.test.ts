import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => {
  class MockNextResponse {
    body: unknown;
    status: number;
    constructor(body: unknown, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

vi.mock('@/src/lib/http/node-url', () => ({ agentCardUrl: () => 'https://imajin.ai/.well-known/agent.json' }));

const reachPrincipalMock = vi.fn();
vi.mock('@/src/lib/auth/agent-reach', () => ({
  reachPrincipal: (...args: unknown[]) => reachPrincipalMock(...args),
}));

const { POST } = await import('../route');

const PRINCIPAL_DID = 'did:imajin:ryan';

function makeRequest(body: unknown) {
  return { json: () => Promise.resolve(body) } as unknown as Request;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    requesterDid: 'did:imajin:muse-agent',
    onBehalfOf: { platform: 'meta-muse', externalRef: 'alice-1', selfDescription: 'Meta Muse acting for Alice' },
    purpose: 'agent.reach',
    field: 'contact_topics',
    predicate: 'contains',
    arg: 'business_development',
    issuedAt: new Date().toISOString(),
    signature: 'deadbeef',
    ...overrides,
  };
}

describe('POST /auth/api/agents/:did/reach', () => {
  beforeEach(() => {
    reachPrincipalMock.mockReset();
  });

  it('rejects a non-DID principal path param with 400 before calling reachPrincipal', async () => {
    const response = await POST(makeRequest(validBody()) as never, { params: Promise.resolve({ did: 'not-a-did' }) });
    expect((response as { status: number }).status).toBe(400);
    expect(reachPrincipalMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with 400', async () => {
    const request = { json: () => Promise.reject(new Error('bad json')) } as unknown as Request;
    const response = await POST(request as never, { params: Promise.resolve({ did: PRINCIPAL_DID }) });
    expect((response as { status: number }).status).toBe(400);
  });

  it('rejects a body missing onBehalfOf with 400', async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).onBehalfOf;
    const response = await POST(makeRequest(body) as never, { params: Promise.resolve({ did: PRINCIPAL_DID }) });
    expect((response as { status: number }).status).toBe(400);
    expect(reachPrincipalMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown predicate with 400', async () => {
    const response = await POST(
      makeRequest(validBody({ predicate: 'not_a_predicate' })) as never,
      { params: Promise.resolve({ did: PRINCIPAL_DID }) },
    );
    expect((response as { status: number }).status).toBe(400);
    expect(reachPrincipalMock).not.toHaveBeenCalled();
  });

  it('returns 200 with only { answer, transcriptHash, issuedAt } on success', async () => {
    reachPrincipalMock.mockResolvedValue({ answer: true, transcriptHash: 'hash123', issuedAt: '2026-01-01T00:00:00.000Z' });

    const response = await POST(makeRequest(validBody()) as never, { params: Promise.resolve({ did: PRINCIPAL_DID }) });
    expect((response as { status: number }).status).toBe(200);
    expect((response as { body: unknown }).body).toEqual({ answer: true, transcriptHash: 'hash123', issuedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('maps a denial to its status code and includes the onboarding pointer', async () => {
    reachPrincipalMock.mockResolvedValue({ denied: true, reason: 'unauthorized', status: 403 });

    const response = await POST(makeRequest(validBody()) as never, { params: Promise.resolve({ did: PRINCIPAL_DID }) });
    expect((response as { status: number }).status).toBe(403);
    expect((response as { body: { error: string; onboarding: string } }).body).toMatchObject({
      error: 'unauthorized',
      onboarding: 'https://imajin.ai/.well-known/agent.json',
    });
  });

  it('forwards the parsed input to reachPrincipal unchanged', async () => {
    reachPrincipalMock.mockResolvedValue({ answer: false, transcriptHash: 'h', issuedAt: 'x' });
    const body = validBody();

    await POST(makeRequest(body) as never, { params: Promise.resolve({ did: PRINCIPAL_DID }) });

    expect(reachPrincipalMock).toHaveBeenCalledWith(PRINCIPAL_DID, expect.objectContaining({
      requesterDid: body.requesterDid,
      onBehalfOf: body.onBehalfOf,
      purpose: body.purpose,
      field: body.field,
      predicate: body.predicate,
      arg: body.arg,
      signature: body.signature,
    }));
  });
});
