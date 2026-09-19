/**
 * GET /typesafe/api/models route tests (#2197).
 *
 * This route doubles as the connect-time key-validation probe (`GET
 * /v1/models`, 401 = bad key) and the connector card's "what can my key do"
 * read -- it must not require an active typesafe:decide grant (#1773
 * precedent).
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const resolveConnectorOwnerDidMock = vi.fn();
const loadTypesafeSealedCredentialsMock = vi.fn();
const typesafeKeyPendingMock = vi.fn();
const getModelsMock = vi.fn();

vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: resolveConnectorOwnerDidMock,
}));
vi.mock('@/src/lib/typesafe/connector', () => ({
  loadTypesafeSealedCredentials: loadTypesafeSealedCredentialsMock,
  typesafeKeyPending: typesafeKeyPendingMock,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/src/lib/typesafe/client', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/typesafe/client')>('@/src/lib/typesafe/client');
  return { ...actual, getModels: getModelsMock };
});

const { GET } = await import('../route');
const { TypesafeUpstreamError } = await import('@/src/lib/typesafe/client');

const OWNER = 'did:imajin:farmer';
const API_KEY = 'ts-sealed-key';

function request(): NextRequest {
  return new NextRequest('https://kernel.test/typesafe/api/models', { method: 'GET' });
}

beforeEach(() => {
  resolveConnectorOwnerDidMock.mockReset().mockResolvedValue({ ok: true, ownerDid: OWNER });
  loadTypesafeSealedCredentialsMock.mockReset().mockResolvedValue({ apiKey: API_KEY });
  typesafeKeyPendingMock.mockReset().mockResolvedValue(false);
  getModelsMock.mockReset();
});

it('rejects an unauthenticated caller', async () => {
  resolveConnectorOwnerDidMock.mockResolvedValue({ ok: false, error: 'not authenticated', status: 401 });

  const res = await GET(request());

  expect(res.status).toBe(401);
  expect(loadTypesafeSealedCredentialsMock).not.toHaveBeenCalled();
});

it('does not require an active typesafe:decide grant (#1773) -- reads the sealed credential directly', async () => {
  getModelsMock.mockResolvedValue({ data: { models: [] }, requestId: null });

  await GET(request());

  expect(loadTypesafeSealedCredentialsMock).toHaveBeenCalledWith(OWNER);
});

it('reports typesafe_no_key when nothing is sealed yet', async () => {
  loadTypesafeSealedCredentialsMock.mockResolvedValue(undefined);

  const res = await GET(request());

  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/typesafe_no_key/);
});

it('distinguishes a key awaiting Tier 1 approval from no key at all', async () => {
  loadTypesafeSealedCredentialsMock.mockResolvedValue(undefined);
  typesafeKeyPendingMock.mockResolvedValue(true);

  const res = await GET(request());

  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/typesafe_credential_pending/);
});

it('returns the model list from GET /v1/models on success (the probe)', async () => {
  const models = [{ name: 'jev-latest', description: 'Latest', release_date: '2026-01-01' }];
  getModelsMock.mockResolvedValue({ data: { models }, requestId: 'req_1' });

  const res = await GET(request());
  const body = await res.json();

  expect(res.status).toBe(200);
  expect(body).toEqual({ models });
  expect(getModelsMock).toHaveBeenCalledWith(API_KEY);
});

it('maps a 401 from the upstream probe to typesafe_invalid_key (bad key)', async () => {
  getModelsMock.mockRejectedValue(new TypesafeUpstreamError(401, { error: 'invalid_api_key' }, null));

  const res = await GET(request());
  const text = await res.text();

  expect(res.status).toBe(401);
  expect(text).not.toContain(API_KEY);
  expect(JSON.parse(text).error).toMatch(/typesafe_invalid_key/);
});

it('maps a non-401 upstream failure to 502 without forwarding the upstream body', async () => {
  getModelsMock.mockRejectedValue(new TypesafeUpstreamError(500, { error: 'server error', secret: API_KEY }, null));

  const res = await GET(request());
  const text = await res.text();

  expect(res.status).toBe(502);
  expect(text).not.toContain(API_KEY);
});

it('maps a transport failure to 502', async () => {
  getModelsMock.mockRejectedValue(new Error('network down'));

  const res = await GET(request());

  expect(res.status).toBe(502);
});
