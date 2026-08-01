/**
 * Unit tests for POST /api/vault/migrate-custody (#1537).
 *
 * The route itself is a thin admin-gated wrapper over `migrateCustody` — these
 * tests pin the parts that live in the route rather than the driver: auth,
 * body validation, the dry-run-by-default safety default, and turning a
 * driver-level throw into a 500 instead of an unhandled rejection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMigrateCustody, mockRequireAdmin } = vi.hoisted(() => ({
  mockMigrateCustody: vi.fn<() => Promise<Record<string, unknown>>>(),
  mockRequireAdmin: vi.fn(async () => true),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));

vi.mock('@/src/lib/vault/migrate-custody', () => ({ migrateCustody: mockMigrateCustody }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

import { POST } from '../route.js';

function makeRequest(body?: unknown): Request {
  return new Request('http://localhost/api/vault/migrate-custody', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    dryRun: true,
    tier1: false,
    totalV1Fields: 0,
    candidateCount: 0,
    results: [],
    aborted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockMigrateCustody.mockResolvedValue(report());
});

describe('POST /api/vault/migrate-custody', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await POST(makeRequest({}) as never);
    expect(response.status).toBe(401);
    expect(mockMigrateCustody).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    const request = new Request('http://localhost/api/vault/migrate-custody', {
      method: 'POST',
      body: '{not json',
    });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
  });

  it('defaults dryRun to true when the body omits it', async () => {
    await POST(makeRequest({}) as never);
    expect(mockMigrateCustody).toHaveBeenCalledWith({ dryRun: true, limit: undefined });
  });

  it('defaults dryRun to true for any value other than a literal false', async () => {
    await POST(makeRequest({ dryRun: 'yes' }) as never);
    expect(mockMigrateCustody).toHaveBeenCalledWith({ dryRun: true, limit: undefined });
  });

  it('only mutates when dryRun is explicitly false', async () => {
    await POST(makeRequest({ dryRun: false }) as never);
    expect(mockMigrateCustody).toHaveBeenCalledWith({ dryRun: false, limit: undefined });
  });

  it('passes limit through when it is a positive integer', async () => {
    await POST(makeRequest({ dryRun: false, limit: 5 }) as never);
    expect(mockMigrateCustody).toHaveBeenCalledWith({ dryRun: false, limit: 5 });
  });

  it('rejects a non-integer limit', async () => {
    const response = await POST(makeRequest({ limit: 1.5 }) as never);
    expect(response.status).toBe(400);
    expect(mockMigrateCustody).not.toHaveBeenCalled();
  });

  it('rejects a zero or negative limit', async () => {
    const response = await POST(makeRequest({ limit: 0 }) as never);
    expect(response.status).toBe(400);
    expect(mockMigrateCustody).not.toHaveBeenCalled();
  });

  it('returns the driver report as JSON', async () => {
    const expected = report({ totalV1Fields: 2, results: [{ field: 'a', status: 'would-upgrade' }] });
    mockMigrateCustody.mockResolvedValue(expected);

    const response = await POST(makeRequest({}) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expected);
  });

  it('surfaces a driver failure as a 500 rather than an unhandled rejection', async () => {
    mockMigrateCustody.mockRejectedValue(new Error('boom'));

    const response = await POST(makeRequest({ dryRun: false }) as never);
    expect(response.status).toBe(500);
  });
});
