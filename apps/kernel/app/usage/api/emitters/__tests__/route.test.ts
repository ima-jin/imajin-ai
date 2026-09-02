import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveEffectiveDid: vi.fn(),
  listEmittersForIssuer: vi.fn(),
  upsertEmitter: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  resolveEffectiveDid: mocks.resolveEffectiveDid,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/usage/emitters-store', () => ({
  listEmittersForIssuer: mocks.listEmittersForIssuer,
  upsertEmitter: mocks.upsertEmitter,
}));

import { GET, PUT, OPTIONS } from '../route';

const ISSUER = 'did:imajin:jin';

function makeGetRequest() {
  return { headers: new Headers(), url: 'https://kernel.test/usage/api/emitters' } as unknown as Parameters<typeof GET>[0];
}

function makePutRequest(body: unknown) {
  return {
    headers: new Headers(),
    url: 'https://kernel.test/usage/api/emitters',
    json: async () => body,
  } as unknown as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: ISSUER, via: 'session', composedBy: null });
  mocks.listEmittersForIssuer.mockResolvedValue([]);
  mocks.upsertEmitter.mockResolvedValue({ source: 'adapter:claude-code', issuerDid: ISSUER });
});

describe('OPTIONS /usage/api/emitters', () => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeGetRequest());
    expect(res.status).toBe(204);
  });
});

describe('GET /usage/api/emitters', () => {
  it('fails closed on missing or invalid auth', async () => {
    mocks.resolveEffectiveDid.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(401);
    expect(mocks.listEmittersForIssuer).not.toHaveBeenCalled();
  });

  it('lists only the caller\u2019s own effective DID emitters', async () => {
    const rows = [{ source: 'adapter:claude-code', issuerDid: ISSUER }];
    mocks.listEmittersForIssuer.mockResolvedValue(rows);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(mocks.listEmittersForIssuer).toHaveBeenCalledWith(ISSUER);
    expect(await res.json()).toEqual({ emitters: rows });
  });

  it('marks the response as no-store', async () => {
    const res = await GET(makeGetRequest());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 500 without leaking the underlying failure when the store throws', async () => {
    mocks.listEmittersForIssuer.mockRejectedValue(new Error('connection reset'));

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Emitter registry unavailable' });
  });
});

describe('PUT /usage/api/emitters', () => {
  it('fails closed on missing or invalid auth', async () => {
    mocks.resolveEffectiveDid.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await PUT(makePutRequest({ source: 'adapter:claude-code', reader: 'tail-jsonl' }));

    expect(res.status).toBe(401);
    expect(mocks.upsertEmitter).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON bodies', async () => {
    const request = {
      headers: new Headers(),
      url: 'https://kernel.test/usage/api/emitters',
      json: async () => { throw new SyntaxError('bad json'); },
    } as unknown as Parameters<typeof PUT>[0];

    const res = await PUT(request);
    expect(res.status).toBe(400);
  });

  it('rejects a missing source', async () => {
    const res = await PUT(makePutRequest({ reader: 'tail-jsonl' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'source must be a non-empty string' });
  });

  it('rejects a missing reader', async () => {
    const res = await PUT(makePutRequest({ source: 'adapter:claude-code' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'reader must be a non-empty string' });
  });

  it('rejects an invalid status', async () => {
    const res = await PUT(makePutRequest({ source: 'adapter:claude-code', reader: 'tail-jsonl', status: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-object config', async () => {
    const res = await PUT(makePutRequest({ source: 'adapter:claude-code', reader: 'tail-jsonl', config: 'not-an-object' }));
    expect(res.status).toBe(400);
  });

  it('forces issuerDid to the caller\u2019s own effective DID, ignoring any client-supplied value', async () => {
    await PUT(makePutRequest({ source: 'adapter:claude-code', reader: 'tail-jsonl', issuerDid: 'did:imajin:someone-else' }));

    expect(mocks.upsertEmitter).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'adapter:claude-code', reader: 'tail-jsonl', issuerDid: ISSUER }),
    );
  });

  it('registers a well-formed emitter and returns it', async () => {
    const registered = { source: 'adapter:claude-code', reader: 'tail-jsonl', issuerDid: ISSUER, status: 'active' };
    mocks.upsertEmitter.mockResolvedValue(registered);

    const res = await PUT(makePutRequest({ source: 'adapter:claude-code', reader: 'tail-jsonl' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emitter: registered });
  });

  it('returns 500 without leaking the underlying failure when the store throws', async () => {
    mocks.upsertEmitter.mockRejectedValue(new Error('deadlock detected'));

    const res = await PUT(makePutRequest({ source: 'adapter:claude-code', reader: 'tail-jsonl' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Emitter registration failed' });
  });
});
