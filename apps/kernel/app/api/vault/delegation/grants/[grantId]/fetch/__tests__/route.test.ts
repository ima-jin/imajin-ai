/**
 * Unit tests for POST /api/vault/delegation/grants/{grantId}/fetch (#2231).
 *
 * Covers: authentication, every non-'ok' outcome's HTTP status mapping (404
 * for not_found/not_grantee, 410 for consumed, 403 for inactive/expired),
 * the success response shape, and that every attempt — success or refusal —
 * publishes the vault.delegation.fetched audit event with no secret material
 * in its payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockFetchGrantSecret, mockPublish } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockFetchGrantSecret: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  authErrorResponse: (authError: { error: string; status: number }) =>
    new Response(JSON.stringify({ error: authError.error }), { status: authError.status }),
}));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/vault', () => ({
  fetchGrantSecret: mockFetchGrantSecret,
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { POST } from '../route.js';

const AGENT = 'did:imajin:gha-runner-agent';
const GRANT_ID = 'vdg_test123';

function makeRequest(): Request {
  return new Request(`http://localhost/api/vault/delegation/grants/${GRANT_ID}/fetch`, { method: 'POST' });
}

function callRoute() {
  return POST(makeRequest() as never, { params: Promise.resolve({ grantId: GRANT_ID }) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ identity: { id: AGENT } });
  mockPublish.mockResolvedValue(undefined);
});

describe('POST /api/vault/delegation/grants/{grantId}/fetch — auth', () => {
  it('returns 401 when not authenticated', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
    const response = await callRoute();
    expect(response.status).toBe(401);
    expect(mockFetchGrantSecret).not.toHaveBeenCalled();
  });

  it('resolves the grantee from the caller identity, not the request body', async () => {
    mockFetchGrantSecret.mockResolvedValue({ status: 'ok', value: 'secret', grant: { field: 'F', purpose: null, oneTime: false, expiresAt: null } });
    await callRoute();
    expect(mockFetchGrantSecret).toHaveBeenCalledWith({ grantId: GRANT_ID, granteeDid: AGENT });
  });
});

describe('POST /api/vault/delegation/grants/{grantId}/fetch — outcomes', () => {
  it('returns 200 with the sealed value on success', async () => {
    mockFetchGrantSecret.mockResolvedValue({
      status: 'ok',
      value: 'ghp_the-secret-token',
      grant: { field: 'gha-runner-token', purpose: 'gha-runner-registration', oneTime: true, expiresAt: null },
    });

    const response = await callRoute();
    const body = await response.json() as { ok: boolean; value: string; field: string; oneTime: boolean };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.value).toBe('ghp_the-secret-token');
    expect(body.field).toBe('gha-runner-token');
    expect(body.oneTime).toBe(true);
  });

  it.each([
    ['not_found', 404],
    ['not_grantee', 404],
    ['inactive', 403],
    ['expired', 403],
    ['consumed', 410],
  ] as const)('maps %s to HTTP %i', async (status, expectedStatus) => {
    mockFetchGrantSecret.mockResolvedValue({ status });
    const response = await callRoute();
    expect(response.status).toBe(expectedStatus);
  });

  it('never leaks the secret value on a non-ok outcome', async () => {
    mockFetchGrantSecret.mockResolvedValue({ status: 'consumed' });
    const response = await callRoute();
    const text = await response.text();
    expect(text).not.toContain('value');
  });

  it('returns a vault error response when fetchGrantSecret throws', async () => {
    mockFetchGrantSecret.mockRejectedValue(new Error('tampered entry'));
    const response = await callRoute();
    expect(response.status).toBe(500);
  });
});

describe('POST /api/vault/delegation/grants/{grantId}/fetch — audit', () => {
  it('publishes vault.delegation.fetched with outcome ok and no secret material on success', async () => {
    mockFetchGrantSecret.mockResolvedValue({
      status: 'ok',
      value: 'ghp_the-secret-token',
      grant: { field: 'gha-runner-token', purpose: 'gha-runner-registration', oneTime: true, expiresAt: null },
    });

    await callRoute();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [eventType, event] = mockPublish.mock.calls[0]!;
    expect(eventType).toBe('vault.delegation.fetched');
    expect(event.payload.outcome).toBe('ok');
    expect(event.payload.grantId).toBe(GRANT_ID);
    expect(JSON.stringify(event.payload)).not.toContain('ghp_the-secret-token');
  });

  it('publishes an audit event for a refused fetch too', async () => {
    mockFetchGrantSecret.mockResolvedValue({ status: 'not_grantee' });
    await callRoute();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, event] = mockPublish.mock.calls[0]!;
    expect(event.payload.outcome).toBe('not_grantee');
  });

  it('publishes an error outcome when the fetch throws', async () => {
    mockFetchGrantSecret.mockRejectedValue(new Error('tampered entry'));
    await callRoute();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [, event] = mockPublish.mock.calls[0]!;
    expect(event.payload.outcome).toBe('error');
  });

  it('never fails the request when the audit publish itself fails', async () => {
    mockPublish.mockRejectedValue(new Error('bus unavailable'));
    mockFetchGrantSecret.mockResolvedValue({
      status: 'ok',
      value: 'secret',
      grant: { field: 'F', purpose: null, oneTime: false, expiresAt: null },
    });

    const response = await callRoute();
    expect(response.status).toBe(200);
  });
});
