import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockGetOperatorDid, mockRead, mockWrite } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockGetOperatorDid: vi.fn(),
  mockRead: vi.fn(),
  mockWrite: vi.fn(),
}));

const OPERATOR_DID = 'did:imajin:operator';

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));

vi.mock('@/src/lib/notify/operator-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/notify/operator-approvals')>();
  return { ...actual, getOperatorDid: mockGetOperatorDid };
});

// Keep the real (pure) validator; stub only the DB-touching read/write.
vi.mock('@/src/lib/jin/front-door', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/jin/front-door')>();
  return { ...actual, readFrontDoorConfig: mockRead, writeFrontDoorConfig: mockWrite };
});

vi.mock('@/src/db', () => ({ db: {}, identities: {}, consentGrants: {} }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GET, PUT, OPTIONS } from '../route';
import { defaultFrontDoorConfig } from '@/src/lib/jin/front-door';

function putReq(body: unknown, raw = false): Request {
  return new Request('https://test.imajin.ai/jin/api/front-door', {
    method: 'PUT',
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

function getReq(): Request {
  return new Request('https://test.imajin.ai/jin/api/front-door');
}

function validBody() {
  const config = defaultFrontDoorConfig();
  config.tiers.preliminary = true;
  config.topics.collaboration = { open: true, published: true, mode: 'deliver' };
  return config;
}

const operator = { identity: { id: OPERATOR_DID, actingFor: undefined } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOperatorDid.mockResolvedValue(OPERATOR_DID);
  mockRead.mockResolvedValue(defaultFrontDoorConfig());
  mockWrite.mockResolvedValue(true);
});

describe('OPTIONS', () => {
  it('delegates to the shared CORS preflight handler', async () => {
    const res = await OPTIONS(getReq() as Parameters<typeof OPTIONS>[0]);
    expect(res.status).toBe(204);
  });
});

describe('GET /jin/api/front-door (#2598)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await GET(getReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it.each([
    ['another human', { id: 'did:imajin:someone-else', actingFor: undefined }],
    ['an agent acting for the operator', { id: 'did:imajin:jin', actingFor: OPERATOR_DID }],
  ])('answers isOperator:false for %s, leaking nothing', async (_name, identity) => {
    mockRequireAuth.mockResolvedValueOnce({ identity });
    const res = await GET(getReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isOperator: false });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('answers isOperator:false when the node has no operator DID', async () => {
    mockRequireAuth.mockResolvedValueOnce(operator);
    mockGetOperatorDid.mockResolvedValueOnce(null);
    const res = await GET(getReq() as Parameters<typeof GET>[0]);
    expect(await res.json()).toEqual({ isOperator: false });
  });

  it('returns the config, topic options and cap limits to the operator', async () => {
    mockRequireAuth.mockResolvedValueOnce(operator);
    const res = await GET(getReq() as Parameters<typeof GET>[0]);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.isOperator).toBe(true);
    expect(json.config).toEqual(defaultFrontDoorConfig());
    expect(json.topicOptions).toContainEqual({ term: 'collaboration', label: 'Collaboration' });
    expect(json.limits).toEqual({ minDailyCap: 1, maxDailyCap: 1000 });
    expect(mockRead).toHaveBeenCalledWith(OPERATOR_DID);
  });

  it('404s when the operator identity row is missing', async () => {
    mockRequireAuth.mockResolvedValueOnce(operator);
    mockRead.mockResolvedValueOnce(null);
    const res = await GET(getReq() as Parameters<typeof GET>[0]);
    expect(res.status).toBe(404);
  });
});

describe('PUT /jin/api/front-door (#2598)', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAuth.mockResolvedValueOnce({ error: 'Unauthorized', status: 401 });
    const res = await PUT(putReq(validBody()) as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(401);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-operator and writes nothing', async () => {
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: 'did:imajin:jin', actingFor: OPERATOR_DID } });
    const res = await PUT(putReq(validBody()) as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(403);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    mockRequireAuth.mockResolvedValueOnce(operator);
    const res = await PUT(putReq('{not json', true) as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });

  it('returns 400 with the validation error and writes nothing', async () => {
    mockRequireAuth.mockResolvedValueOnce(operator);
    const bad = { ...validBody(), tiers: { anonymous: true, soft: false, preliminary: false, established: false } };
    const res = await PUT(putReq(bad) as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/anonymous tier is reach_card only/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('writes the validated config for the operator DID (never a client-supplied DID)', async () => {
    mockRequireAuth.mockResolvedValueOnce(operator);
    const res = await PUT(putReq({ ...validBody(), principalDid: 'did:imajin:victim' }) as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(OPERATOR_DID, validBody());
    expect(await res.json()).toEqual({ isOperator: true, config: validBody() });
  });

  it('404s when the operator identity row is missing', async () => {
    mockRequireAuth.mockResolvedValueOnce(operator);
    mockWrite.mockResolvedValueOnce(false);
    const res = await PUT(putReq(validBody()) as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(404);
  });
});
