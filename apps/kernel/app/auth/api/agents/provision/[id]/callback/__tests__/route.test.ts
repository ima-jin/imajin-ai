/**
 * Tests for POST /auth/api/agents/provision/[id]/callback (#1933) — the
 * operator-run runner's boot-status callback, shared-secret authenticated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { recordBootStatusMock } = vi.hoisted(() => ({ recordBootStatusMock: vi.fn() }));

vi.mock('@/src/lib/auth/agent-provisioner', () => ({
  recordBootStatus: recordBootStatusMock,
}));

import { POST } from '../route';

const ENDPOINT = 'http://localhost:3000/auth/api/agents/provision/prov_1/callback';

type RouteRequest = Parameters<typeof POST>[0];

function makeRequest(body?: unknown, token?: string): RouteRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['x-provisioner-runner-token'] = token;
  return new Request(ENDPOINT, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as RouteRequest;
}

function ctx(id = 'prov_1') {
  return { params: Promise.resolve({ id }) };
}

const ORIGINAL_TOKEN = process.env.PROVISIONER_RUNNER_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PROVISIONER_RUNNER_TOKEN = 'test-runner-secret';
});

afterEach(() => {
  process.env.PROVISIONER_RUNNER_TOKEN = ORIGINAL_TOKEN;
});

describe('POST /auth/api/agents/provision/[id]/callback', () => {
  it('refuses every callback when the token is not configured on this node', async () => {
    delete process.env.PROVISIONER_RUNNER_TOKEN;

    const res = await POST(makeRequest({ status: 'booted' }, 'anything'), ctx());
    expect(res.status).toBe(503);
    expect(recordBootStatusMock).not.toHaveBeenCalled();
  });

  it('rejects a missing token', async () => {
    const res = await POST(makeRequest({ status: 'booted' }), ctx());
    expect(res.status).toBe(401);
    expect(recordBootStatusMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched token', async () => {
    const res = await POST(makeRequest({ status: 'booted' }, 'wrong-token'), ctx());
    expect(res.status).toBe(401);
    expect(recordBootStatusMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid status value', async () => {
    const res = await POST(makeRequest({ status: 'weird' }, 'test-runner-secret'), ctx());
    expect(res.status).toBe(400);
    expect(recordBootStatusMock).not.toHaveBeenCalled();
  });

  it('records a booted status with a valid token', async () => {
    recordBootStatusMock.mockResolvedValue({ id: 'prov_1', status: 'booted' });

    const res = await POST(makeRequest({ status: 'booted' }, 'test-runner-secret'), ctx());
    expect(res.status).toBe(200);
    expect(recordBootStatusMock).toHaveBeenCalledWith('prov_1', 'booted', undefined);
  });

  it('returns 404 when the provision does not exist', async () => {
    recordBootStatusMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ status: 'failed', detail: 'compose up failed' }, 'test-runner-secret'), ctx());
    expect(res.status).toBe(404);
  });
});
