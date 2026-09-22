import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => {
  class MockNextResponse {
    body: unknown;
    status: number;
    headers: Record<string, string>;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? {};
    }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

vi.mock('@/src/lib/http/node-url', () => ({
  nodeUrl: () => 'https://imajin.ai',
  agentCardUrl: () => 'https://imajin.ai/.well-known/agent.json',
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

type Row = Record<string, unknown>;

const { identitiesStore } = vi.hoisted(() => ({ identitiesStore: new Map<string, Row>() }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: (column: string, value: unknown) => (row: Row) => row[column] === value };
});

function projectRow(row: Row, projection: Record<string, string>): Row {
  const result: Row = {};
  for (const key of Object.keys(projection)) result[key] = row[projection[key]];
  return result;
}

function limitResult(rows: Row[], projection: Record<string, string>) {
  const projected = rows.map((row) => projectRow(row, projection));
  return { limit: (n: number) => Promise.resolve(projected.slice(0, n)) };
}

function whereClause(projection: Record<string, string>) {
  return { where: (predicate: (row: Row) => boolean) => limitResult([...identitiesStore.values()].filter(predicate), projection) };
}

vi.mock('@/src/db', () => ({
  db: { select: (projection: Record<string, string>) => ({ from: () => whereClause(projection) }) },
  identities: { id: 'id', handle: 'handle', name: 'name' },
}));

const { GET } = await import('../route');

describe('GET /.well-known/agent/:id (#2251)', () => {
  beforeEach(() => {
    identitiesStore.clear();
    identitiesStore.set('did:imajin:ryan', { id: 'did:imajin:ryan', handle: 'ryan', name: 'Ryan' });
  });

  it('returns 404 with an onboarding pointer when the principal does not resolve', async () => {
    const response = await GET({} as never, { params: Promise.resolve({ id: 'did:imajin:nobody' }) });
    expect((response as { status: number }).status).toBe(404);
    expect((response as { body: { onboarding: string } }).body.onboarding).toBe('https://imajin.ai/.well-known/agent.json');
  });

  it('resolves by DID and returns the reach endpoint pointing at this slice\'s new route', async () => {
    const response = await GET({} as never, { params: Promise.resolve({ id: 'did:imajin:ryan' }) });
    const body = (response as { body: { principalDid: string; reach: { endpoint: string } } }).body;
    expect(body.principalDid).toBe('did:imajin:ryan');
    expect(body.reach.endpoint).toBe('https://imajin.ai/auth/api/agents/did%3Aimajin%3Aryan/reach');
  });

  it('resolves by handle as well as DID', async () => {
    const response = await GET({} as never, { params: Promise.resolve({ id: 'ryan' }) });
    const body = (response as { body: { principalDid: string } }).body;
    expect(body.principalDid).toBe('did:imajin:ryan');
  });

  it('advertises the same knock onboarding flow the platform-wide agent card uses', async () => {
    const response = await GET({} as never, { params: Promise.resolve({ id: 'did:imajin:ryan' }) });
    const body = (response as { body: { onboarding: { flow: string; endpoint: string } } }).body;
    expect(body.onboarding.flow).toBe('knock');
    expect(body.onboarding.endpoint).toBe('https://imajin.ai/auth/api/knock');
  });
});
