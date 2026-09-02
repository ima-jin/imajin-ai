import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAppAuth: vi.fn(),
  rateLimit: vi.fn(),
  getClientIP: vi.fn(),
  getEmitter: vi.fn(),
  insertedIds: [] as Array<{ id: string } | undefined>,
  insertValues: [] as Record<string, unknown>[],
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mocks.requireAppAuth,
}));

vi.mock('@imajin/config', () => ({
  rateLimit: mocks.rateLimit,
  getClientIP: mocks.getClientIP,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/usage/emitters-store', () => ({
  getEmitter: mocks.getEmitter,
  callerMatchesEmitter: (emitter: { issuerDid: string; actingFor: string | null }, callerDid: string) =>
    callerDid === emitter.issuerDid || (emitter.actingFor !== null && callerDid === emitter.actingFor),
  isActiveEmitter: (emitter: { status: string } | undefined) => Boolean(emitter) && emitter!.status === 'active',
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

async function mockReturning() {
  const next = mocks.insertedIds.shift();
  return next ? [next] : [];
}

function mockOnConflictDoNothing() {
  return { returning: mockReturning };
}

function mockValues(v: Record<string, unknown>) {
  mocks.insertValues.push(v);
  return { onConflictDoNothing: mockOnConflictDoNothing };
}

vi.mock('@/src/db', () => ({
  db: {
    insert: () => ({ values: mockValues }),
  },
  usageIncurred: { source: 'source', externalId: 'external_id', id: 'id' },
}));

import { POST, OPTIONS } from '../route';

const APP_DID = 'did:imajin:adapter-claude-code';
const ISSUER_DID = 'did:imajin:jin';

function makeRequest(body: unknown) {
  return {
    headers: new Headers(),
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

function goodRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'adapter:claude-code',
    resource: 'model:anthropic/claude-sonnet-4-5',
    external_id: 'msg_1',
    ts: '2026-01-01T00:00:00.000Z',
    tokens_in: 10,
    tokens_out: 5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertedIds.length = 0;
  mocks.insertValues.length = 0;
  mocks.getClientIP.mockReturnValue('127.0.0.1');
  mocks.rateLimit.mockReturnValue({ limited: false, retryAfter: 0 });
  mocks.requireAppAuth.mockResolvedValue({
    appAuth: { appDid: APP_DID, userDid: '', scopes: ['usage:emit'], attestationId: '', isServiceToken: true },
  });
  mocks.getEmitter.mockResolvedValue({
    source: 'adapter:claude-code',
    reader: 'tail-jsonl',
    issuerDid: APP_DID,
    actingFor: null,
    status: 'active',
  });
  mocks.insertedIds.push({ id: 'usage_1' });
});

describe('OPTIONS /usage/api/incurred', () => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeRequest(undefined));
    expect(res.status).toBe(204);
  });
});

describe('POST /usage/api/incurred — rate limit + auth', () => {
  it('fails closed when rate limited', async () => {
    mocks.rateLimit.mockReturnValue({ limited: true, retryAfter: 30 });

    const res = await POST(makeRequest([goodRow()]));

    expect(res.status).toBe(429);
    expect(mocks.requireAppAuth).not.toHaveBeenCalled();
  });

  it('fails closed when app auth fails', async () => {
    mocks.requireAppAuth.mockResolvedValue({ error: 'Invalid app token', status: 401 });

    const res = await POST(makeRequest([goodRow()]));

    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON bodies', async () => {
    const request = {
      headers: new Headers(),
      json: async () => { throw new SyntaxError('bad json'); },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(request);
    expect(res.status).toBe(400);
  });
});

describe('POST /usage/api/incurred — batch envelope validation', () => {
  it('rejects a non-array body', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body must be an array of rows' });
  });

  it('rejects an empty batch', async () => {
    const res = await POST(makeRequest([]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body must not be empty' });
  });
});

describe('POST /usage/api/incurred — source/issuer validation', () => {
  it('rejects a row naming an unknown source', async () => {
    mocks.getEmitter.mockResolvedValue(undefined);

    const res = await POST(makeRequest([goodRow({ source: 'adapter:unknown' })]));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.inserted).toBe(0);
    expect(body.rejected).toEqual([{ index: 0, reason: 'unknown or inactive emitter source: adapter:unknown' }]);
  });

  it('rejects a row naming a revoked source', async () => {
    mocks.getEmitter.mockResolvedValue({ source: 'adapter:claude-code', issuerDid: APP_DID, actingFor: null, status: 'revoked' });

    const res = await POST(makeRequest([goodRow()]));

    const body = await res.json();
    expect(body.rejected).toEqual([{ index: 0, reason: 'unknown or inactive emitter source: adapter:claude-code' }]);
  });

  it('rejects a caller that is neither the issuer nor acting_for', async () => {
    mocks.getEmitter.mockResolvedValue({ source: 'adapter:claude-code', issuerDid: ISSUER_DID, actingFor: null, status: 'active' });

    const res = await POST(makeRequest([goodRow()]));

    const body = await res.json();
    expect(body.rejected).toEqual([{ index: 0, reason: "caller is not this emitter's issuer_did or acting_for" }]);
  });

  it('accepts a caller matching acting_for even when it differs from issuer_did', async () => {
    mocks.requireAppAuth.mockResolvedValue({
      appAuth: { appDid: 'did:imajin:delegated-agent', userDid: '', scopes: ['usage:emit'], attestationId: '', isServiceToken: true },
    });
    mocks.getEmitter.mockResolvedValue({
      source: 'adapter:claude-code',
      issuerDid: ISSUER_DID,
      actingFor: 'did:imajin:delegated-agent',
      status: 'active',
    });

    const res = await POST(makeRequest([goodRow()]));

    const body = await res.json();
    expect(body.inserted).toBe(1);
    expect(body.rejected).toEqual([]);
  });
});

describe('POST /usage/api/incurred — insert + dedupe', () => {
  it('reports an inserted row and writes derived provider/model for a model:* resource', async () => {
    const res = await POST(makeRequest([goodRow()]));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ inserted: 1, skipped: 0, rejected: [] });
    expect(mocks.insertValues[0]).toMatchObject({
      source: 'adapter:claude-code',
      resource: 'model:anthropic/claude-sonnet-4-5',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      externalId: 'msg_1',
      tokensIn: 10,
      tokensOut: 5,
    });
  });

  it('reports skipped (not inserted) when the dedupe conflict target already exists', async () => {
    mocks.insertedIds.length = 0; // onConflictDoNothing returns no row

    const res = await POST(makeRequest([goodRow()]));

    const body = await res.json();
    expect(body).toEqual({ inserted: 0, skipped: 1, rejected: [] });
  });

  it('handles a batch with a mix of accepted, rejected, and validation-failed rows independently', async () => {
    mocks.getEmitter.mockImplementation(async (source: string) =>
      source === 'adapter:claude-code'
        ? { source: 'adapter:claude-code', issuerDid: APP_DID, actingFor: null, status: 'active' }
        : undefined,
    );
    mocks.insertedIds.push({ id: 'usage_2' });

    const res = await POST(
      makeRequest([
        goodRow({ external_id: 'msg_1' }),
        { source: 'adapter:claude-code' }, // fails structural validation (missing resource/external_id/ts)
        goodRow({ external_id: 'msg_2', source: 'adapter:unregistered' }),
      ]),
    );

    const body = await res.json();
    expect(body.inserted).toBe(1);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 2]);
  });

  it('derives provider/model for a non-model resource rather than failing NOT NULL columns', async () => {
    mocks.getEmitter.mockResolvedValue({ source: 'adapter:claude-code', issuerDid: APP_DID, actingFor: null, status: 'active' });

    await POST(makeRequest([goodRow({ resource: 'tool:linter', external_id: 'msg_3' })]));

    expect(mocks.insertValues[0]).toMatchObject({ provider: 'tool', model: 'linter' });
  });
});
