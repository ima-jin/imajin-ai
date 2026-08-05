import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAppAuth, mockReadStatus } = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockReadStatus: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mockRequireAppAuth,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://agri.example' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/kernel/connector-status', () => ({
  readConnectorConnectionStatus: mockReadStatus,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { GET, OPTIONS } from '../route';
import { readConnectorConnectionStatus } from '@/src/lib/kernel/connector-status';

const USER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:agrifortress-app';

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(): RouteRequest {
  return { headers: new Headers() } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAppAuth.mockResolvedValue({
    appAuth: {
      appDid: APP_DID,
      userDid: USER_DID,
      scopes: ['connectors:read-status'],
      attestationId: 'att_app',
    },
  });
  mockReadStatus.mockResolvedValue([
    { id: 'quickbooks', connected: true, scopes: ['quickbooks:write'] },
    { id: 'gemini', connected: false, scopes: [] },
  ]);
});

describe('GET /connections/api/connectors/status (#1540)', () => {
  it('requires the connectors:read-status app scope', async () => {
    await GET(makeReq());

    expect(mockRequireAppAuth).toHaveBeenCalledWith(
      expect.anything(),
      { scope: 'connectors:read-status' },
    );
  });

  it('returns live connector status for the delegating user', async () => {
    const res = await GET(makeReq());

    expect(readConnectorConnectionStatus).toHaveBeenCalledWith(USER_DID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 'quickbooks', connected: true, scopes: ['quickbooks:write'] },
      { id: 'gemini', connected: false, scopes: [] },
    ]);
  });

  it('fails closed on missing or insufficient app consent', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: "Scope 'connectors:read-status' was not granted", status: 403 });

    const res = await GET(makeReq());

    expect(res.status).toBe(403);
    expect(readConnectorConnectionStatus).not.toHaveBeenCalled();
  });

  it('rejects service tokens with no delegating user', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: {
        appDid: APP_DID,
        userDid: '',
        scopes: ['connectors:read-status'],
        attestationId: '',
        isServiceToken: true,
      },
    });

    const res = await GET(makeReq());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'App token has no delegating user' });
    expect(readConnectorConnectionStatus).not.toHaveBeenCalled();
  });

  it('does not expose credential-shaped fields', async () => {
    const res = await GET(makeReq());
    const bodyText = JSON.stringify(await res.json());

    expect(bodyText).not.toContain('token');
    expect(bodyText).not.toContain('secret');
    expect(bodyText).not.toContain('apiKey');
    expect(bodyText).not.toContain('config');
  });

  it('marks the live status response as no-store', async () => {
    const res = await GET(makeReq());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq());
    expect(res.status).toBe(204);
  });
});
