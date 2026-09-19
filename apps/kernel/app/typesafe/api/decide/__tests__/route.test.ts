/**
 * POST /typesafe/api/decide route tests (#2197).
 *
 * Covers: requireAuth + typesafe:decide scope gating, body validation,
 * byte-for-byte pass-through of the upstream response, opaque upstream
 * error surfacing (422 verbatim, never retried by the route itself -- that
 * lives in the client), usage-ledger recording, and that the sealed key
 * never appears anywhere in a response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const resolveConnectorOwnerDidMock = vi.fn();
const requireGrantAndKeyMock = vi.fn();
const postSystemOneMock = vi.fn();
const recordTypesafeUsageMock = vi.fn(async () => undefined);

vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: resolveConnectorOwnerDidMock,
}));
vi.mock('@/src/lib/typesafe/connector', () => ({
  requireGrantAndKey: requireGrantAndKeyMock,
  TYPESAFE_DECIDE_SCOPE: 'typesafe:decide',
}));
vi.mock('@/src/lib/typesafe/usage', () => ({
  recordTypesafeUsage: recordTypesafeUsageMock,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Import the real client module for its TypesafeUpstreamError class, but
// stub postSystemOne so no real network call is ever attempted.
vi.mock('@/src/lib/typesafe/client', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/typesafe/client')>('@/src/lib/typesafe/client');
  return { ...actual, postSystemOne: postSystemOneMock };
});

const { POST } = await import('../route');
const { TypesafeUpstreamError } = await import('@/src/lib/typesafe/client');

const OWNER = 'did:imajin:farmer';
const API_KEY = 'ts-sealed-key';
const VALID_BODY = {
  state: { orderId: 'ord_1' },
  questions: {
    is_fraud: { type: 'noul', instructions: 'Is this fraudulent?' },
  },
};

function request(body: unknown): NextRequest {
  return new NextRequest('https://kernel.test/typesafe/api/decide', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resolveConnectorOwnerDidMock.mockReset().mockResolvedValue({ ok: true, ownerDid: OWNER });
  requireGrantAndKeyMock.mockReset().mockResolvedValue(API_KEY);
  postSystemOneMock.mockReset();
  recordTypesafeUsageMock.mockClear();
});

describe('auth and scope gating', () => {
  it('rejects when the caller is not authenticated', async () => {
    resolveConnectorOwnerDidMock.mockResolvedValue({ ok: false, error: 'not authenticated', status: 401 });

    const res = await POST(request(VALID_BODY));

    expect(res.status).toBe(401);
    expect(requireGrantAndKeyMock).not.toHaveBeenCalled();
  });

  it('spends the key only behind requireGrantAndKey(ownerDid, typesafe:decide)', async () => {
    postSystemOneMock.mockResolvedValue({ data: { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }, requestId: null });

    await POST(request(VALID_BODY));

    expect(requireGrantAndKeyMock).toHaveBeenCalledWith(OWNER, 'typesafe:decide');
  });

  it('maps typesafe_no_grant to 403', async () => {
    requireGrantAndKeyMock.mockRejectedValue(new Error('typesafe_no_grant: DID has no active grant'));

    const res = await POST(request(VALID_BODY));

    expect(res.status).toBe(403);
    expect(postSystemOneMock).not.toHaveBeenCalled();
  });

  it('maps typesafe_credential_pending to 409', async () => {
    requireGrantAndKeyMock.mockRejectedValue(new Error('typesafe_credential_pending: awaiting owner approval'));

    const res = await POST(request(VALID_BODY));

    expect(res.status).toBe(409);
  });

  it('maps typesafe_no_key to 400', async () => {
    requireGrantAndKeyMock.mockRejectedValue(new Error('typesafe_no_key: no key sealed'));

    const res = await POST(request(VALID_BODY));

    expect(res.status).toBe(400);
  });
});

describe('body validation', () => {
  it('rejects invalid JSON', async () => {
    const badRequest = new NextRequest('https://kernel.test/typesafe/api/decide', {
      method: 'POST',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    });

    const res = await POST(badRequest);

    expect(res.status).toBe(400);
  });

  it('rejects a missing state', async () => {
    const res = await POST(request({ questions: VALID_BODY.questions }));
    expect(res.status).toBe(400);
  });

  it('rejects empty questions', async () => {
    const res = await POST(request({ state: 'foo', questions: {} }));
    expect(res.status).toBe(400);
  });

  it('rejects a choice question missing criteria', async () => {
    const res = await POST(request({
      state: 'foo',
      questions: { category: { type: 'choice', instructions: 'Classify' } },
    }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown model', async () => {
    const res = await POST(request({ ...VALID_BODY, model: 'gpt-4' }));
    expect(res.status).toBe(400);
  });

  it('defaults model to jev-latest when omitted', async () => {
    postSystemOneMock.mockResolvedValue({ data: { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }, requestId: null });

    await POST(request(VALID_BODY));

    expect(postSystemOneMock).toHaveBeenCalledWith(API_KEY, expect.objectContaining({ model: 'jev-latest' }));
  });
});

describe('success path', () => {
  it('passes answers/usage/model through byte-for-byte and includes requestId', async () => {
    const upstream = {
      model: 'jev-1.13.0',
      answers: { is_fraud: { noul: 0.03 } },
      usage: { input_tokens: 100, output_tokens: 0 },
    };
    postSystemOneMock.mockResolvedValue({ data: upstream, requestId: 'req_xyz' });

    const res = await POST(request(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ answers: upstream.answers, usage: upstream.usage, model: upstream.model, requestId: 'req_xyz' });
    expect(res.headers.get('x-typesafe-request-id')).toBe('req_xyz');
  });

  it('records usage with the resolved model and token counts', async () => {
    const upstream = { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 50, output_tokens: 0 } };
    postSystemOneMock.mockResolvedValue({ data: upstream, requestId: null });

    await POST(request(VALID_BODY));

    expect(recordTypesafeUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      ownerDid: OWNER,
      model: 'jev-1.13.0',
      tokensIn: 50,
      tokensOut: 0,
    }));
  });

  it('never returns the sealed API key anywhere in the response', async () => {
    postSystemOneMock.mockResolvedValue({ data: { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }, requestId: null });

    const res = await POST(request(VALID_BODY));
    const text = await res.text();

    expect(text).not.toContain(API_KEY);
  });
});

describe('upstream error surfacing', () => {
  it('surfaces a 422 upstream body opaquely, with the upstream status', async () => {
    postSystemOneMock.mockRejectedValue(new TypesafeUpstreamError(422, { error: 'invalid_criteria' }, 'req_err'));

    const res = await POST(request(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body).toEqual({ error: 'invalid_criteria' });
    expect(res.headers.get('x-typesafe-request-id')).toBe('req_err');
    expect(recordTypesafeUsageMock).not.toHaveBeenCalled();
  });

  it('maps an unexpected transport failure to 502 without leaking the key', async () => {
    postSystemOneMock.mockRejectedValue(new Error('network down'));

    const res = await POST(request(VALID_BODY));
    const text = await res.text();

    expect(res.status).toBe(502);
    expect(text).not.toContain(API_KEY);
  });
});
