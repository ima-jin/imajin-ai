import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const mockReturning = vi.fn();
const mockWhere = vi.fn(() => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockWhere }));

vi.mock('@/src/db', () => ({
  db: { update: vi.fn(() => ({ set: mockSet })) },
  consentGrants: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn(() => Promise.resolve()) }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })),
}));

import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { revokeAll } from '../routes/revoke-all';

const URL = 'https://test.imajin.ai/api/broker/consent/revoke-all';

function post(body: unknown) {
  return new Request(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/broker/consent/revoke-all', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Nope', status: 401 } as any);
    const res = await revokeAll(post({ grantedTo: 'did:imajin:kai' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 (and does not touch the db) when no filter is provided', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:me' } } as any);
    const res = await revokeAll(post({}));
    expect(res.status).toBe(400);
    expect(mockReturning).not.toHaveBeenCalled();
  });

  it('revokes matching grants, returns the count, publishes one event per row', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:me' } } as any);
    const revoked = [
      { id: 'consent_1', subject: 'did:imajin:me', grantedTo: 'did:imajin:kai', purpose: 'dietary' },
      { id: 'consent_2', subject: 'did:imajin:me', grantedTo: 'did:imajin:kai', purpose: 'age' },
    ];
    mockReturning.mockResolvedValueOnce(revoked);

    const res = await revokeAll(post({ grantedTo: 'did:imajin:kai' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.revokedCount).toBe(2);
    expect(vi.mocked(publish)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(publish)).toHaveBeenCalledWith(
      'broker.consent.revoked',
      expect.objectContaining({ issuer: 'did:imajin:me' }),
    );
  });
});
