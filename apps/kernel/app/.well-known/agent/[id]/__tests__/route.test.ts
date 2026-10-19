import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => {
  class MockNextResponse {
    body: unknown;
    status: number;
    headers: Headers;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
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

const { identitiesStore, readConfig } = vi.hoisted(() => ({
  identitiesStore: new Map<string, Row>(), readConfig: vi.fn(),
}));

vi.mock('@/src/lib/jin/front-door', async (original) => ({
  ...await original<typeof import('@/src/lib/jin/front-door')>(),
  readFrontDoorConfig: readConfig,
}));

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
  identities: {
    id: 'id', handle: 'handle', name: 'name', metadata: 'metadata',
    scope: 'scope', subtype: 'subtype', suspendedAt: 'suspendedAt',
  },
}));

// front-door.ts (imported for publishedTopicLabels) also pulls the bus; the card route only needs the pure helper.
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));

const { GET, OPTIONS } = await import('../route');
const { buildReachCard, resolveReachDiscovery } = await import('@/src/lib/auth/reach-discovery');

describe('GET /.well-known/agent/:id (#2251)', () => {
  beforeEach(() => {
    identitiesStore.clear();
    readConfig.mockReset().mockResolvedValue({ tiers: { soft: true, preliminary: false, established: false } });
    identitiesStore.set('did:imajin:ryan', {
      id: 'did:imajin:ryan', handle: 'ryan', name: 'Ryan', scope: 'actor', subtype: 'human',
    });
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
    expect(body.onboarding.endpoint).toBe('https://imajin.ai/reach/ryan/knock');
  });

  describe('published topics (#2598)', () => {
    type Card = { reach: { topics?: string[] } };

    it('omits topics entirely when nothing is published', async () => {
      const response = await GET({} as never, { params: Promise.resolve({ id: 'did:imajin:ryan' }) });
      expect('topics' in (response as { body: Card }).body.reach).toBe(false);
    });

    it('publishes only the labels of open topics the principal opted to publish', async () => {
      const topic = (open: boolean, published: boolean) => ({ open, published, mode: 'deliver' });
      identitiesStore.set('did:imajin:ryan', {
        id: 'did:imajin:ryan',
        handle: 'ryan',
        name: 'Ryan',
        scope: 'actor',
        subtype: 'human',
        metadata: {
          agentReachTopics: ['collaboration', 'speaking'],
          agentReachGate: {
            tiers: { anonymous: false, soft: false, preliminary: true, established: false },
            topics: {
              collaboration: topic(true, true),
              speaking: topic(true, false),
              business_development: topic(false, false),
            },
            dailyCap: 25,
          },
        },
      });
      const response = await GET({} as never, { params: Promise.resolve({ id: 'did:imajin:ryan' }) });
      const body = (response as { body: Card }).body;
      expect(body.reach.topics).toEqual(['Collaboration']);
      expect(JSON.stringify(body)).not.toContain('Speaking');
    });
  });

  it.each(['@ryan', '%40ryan', 'did%3Aimajin%3Aryan'])('resolves %s to the same canonical card', async (id) => {
    const card = await resolveReachDiscovery(id);
    expect(card?.principalDid).toBe('did:imajin:ryan');
    expect(card?.url).toBe('https://imajin.ai/.well-known/agent/did%3Aimajin%3Aryan');
    expect(card?.instructionsUrl).toBe('https://imajin.ai/ryan/reach');
  });

  it('retains the 0.1 contract while advertising only live transports and accurate credential tiers', async () => {
    const card = await resolveReachDiscovery('@ryan');
    expect(card).toMatchObject({
      schemaVersion: '0.1',
      reach: { protocol: 'imajin-agent-reach/0.1' },
      authentication: { schemes: expect.arrayContaining(['did-imajin']) },
      onboarding: { flow: 'knock' },
    });
    expect(card?.transports.map(({ id }) => id)).toEqual(['mcp', 'openapi', 'signed']);
    expect(card?.transports[0]).toMatchObject({
      endpoint: 'https://imajin.ai/reach/ryan/mcp',
      authentication: ['anonymous', 'reach-bearer'],
      discovery: 'https://imajin.ai/.well-known/oauth-protected-resource/reach/ryan/mcp',
      tools: ['reach_card', 'reach_ask', 'reach_send', 'reach_status'],
    });
    expect(card?.transports[1].endpoint).toBe('https://imajin.ai/reach/ryan/openapi.json');
    expect(card?.authentication.tiers.map(({ id }) => id)).toEqual(['anonymous', 'reach-bearer', 'did-imajin', 'did-web']);
    expect(JSON.stringify(card)).not.toMatch(/agent-card\.json|authorization_endpoint/);
  });

  it.each([null, { tiers: { soft: false, preliminary: false, established: false } }])(
    'does not publish a disabled reach card',
    async (config) => {
      readConfig.mockResolvedValue(config);
      const response = await GET({} as never, { params: Promise.resolve({ id: '@ryan' }) });
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(JSON.stringify(response.body)).not.toContain('transports');
    },
  );

  it.each([
    { scope: 'business' }, { subtype: 'agent' }, { suspendedAt: new Date() },
  ])('withholds discovery for ineligible identities: %j', async (patch) => {
    Object.assign(identitiesStore.get('did:imajin:ryan')!, patch);
    expect(await resolveReachDiscovery('ryan')).toBeNull();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it.each(['', '@', '%not-encoded'])('rejects malformed or empty identifiers: %s', async (id) => {
    expect(await resolveReachDiscovery(id)).toBeNull();
  });

  it('uses the DID in transport URLs for principals without a handle', () => {
    const card = buildReachCard({ id: 'did:imajin:123', handle: null, name: null, metadata: null }, 'https://node.example');
    expect(card.instructionsUrl).toBe('https://node.example/did%3Aimajin%3A123/reach');
    expect(card.transports[0].endpoint).toBe('https://node.example/reach/did%3Aimajin%3A123/mcp');
  });

  it('does not expose private policy even when arbitrary metadata exists', async () => {
    Object.assign(identitiesStore.get('did:imajin:ryan')!, {
      metadata: { dailyCap: 12, privateTopic: 'private marker', agentReachTopics: ['speaking'] },
    });
    const card = await resolveReachDiscovery('ryan');
    expect(JSON.stringify(card)).not.toMatch(/private marker|dailyCap|agentReachTopics|agentReachGate/);
  });

  it('responds with uncached, sanitized failure metadata', async () => {
    readConfig.mockRejectedValue(new Error('private database details'));
    const response = await GET({} as never, { params: Promise.resolve({ id: 'ryan' }) });
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain('private database details');
  });

  it('allows public cross-origin discovery preflight', async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
