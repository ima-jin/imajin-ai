import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const mockOrderBy = vi.fn();
const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));

vi.mock('@/src/db', () => ({
  db: { select: vi.fn(() => ({ from: mockFrom })) },
  consentGrants: {},
  brokerAuditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  desc: (arg: unknown) => ({ desc: arg }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id),
}));

import { requireAuth } from '@imajin/auth';
import { getContactDisclosures } from '../routes/contact-disclosures';

const URL = 'https://test.imajin.ai/api/broker/contacts/x/disclosures';

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/broker/contacts/[did]/disclosures', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Nope', status: 401 } as any);
    const res = await getContactDisclosures(new Request(URL), 'did:imajin:kai');
    expect(res.status).toBe(401);
  });

  it('returns 400 when the did is blank', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:me' } } as any);
    const res = await getContactDisclosures(new Request(URL), '   ');
    expect(res.status).toBe(400);
  });

  it('returns grants + audit for the recipient, scoped to the subject', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:me' } } as any);
    const grants = [{ id: 'consent_1', grantedTo: 'did:imajin:kai', status: 'active' }];
    const audit = [{ id: 'audit_1', requester: 'did:imajin:kai', type: 'release' }];
    mockOrderBy.mockResolvedValueOnce(grants).mockResolvedValueOnce(audit);

    const res = await getContactDisclosures(new Request(URL), 'did:imajin:kai');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.did).toBe('did:imajin:kai');
    expect(body.grants).toEqual(grants);
    expect(body.audit).toEqual(audit);

    // Subject scoping is present in the grants query.
    expect(JSON.stringify((mockWhere.mock.calls[0] as unknown[])[0])).toContain('did:imajin:me');
  });
});
