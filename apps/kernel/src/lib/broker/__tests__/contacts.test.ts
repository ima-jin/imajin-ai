import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const mockWhere = vi.fn();
const mockFrom = vi.fn(() => ({ where: mockWhere }));

vi.mock('@/src/db', () => ({
  db: { select: vi.fn(() => ({ from: mockFrom })) },
  consentGrants: {},
  brokerAuditLog: {},
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

import { requireAuth } from '@imajin/auth';
import { getContacts } from '../routes/contacts';

const URL = 'https://test.imajin.ai/api/broker/contacts';

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/broker/contacts', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 } as any);
    const res = await getContacts(new Request(URL));
    expect(res.status).toBe(401);
  });

  it('aggregates by recipient, attaches last disclosure, excludes class grants', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:me' } } as any);
    const grants = [
      { grantedTo: 'did:imajin:kai', grantedToClass: null, purpose: 'dietary', status: 'active', expiresAt: null },
      { grantedTo: 'did:imajin:kai', grantedToClass: null, purpose: 'age', status: 'revoked', expiresAt: null },
      { grantedTo: 'did:imajin:mooi', grantedToClass: null, purpose: 'age', status: 'active', expiresAt: null },
      { grantedTo: null, grantedToClass: 'connections', purpose: 'dietary', status: 'active', expiresAt: null },
    ];
    const releases = [
      { requester: 'did:imajin:kai', createdAt: new Date('2026-06-15T19:00:00Z') },
      { requester: 'did:imajin:kai', createdAt: new Date('2026-06-10T19:00:00Z') },
    ];
    mockWhere.mockResolvedValueOnce(grants).mockResolvedValueOnce(releases);

    const res = await getContacts(new Request(URL));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The class grant (grantedTo === null) is excluded from the contact view.
    expect(body.contacts).toHaveLength(2);

    const kai = body.contacts.find((c: { did: string }) => c.did === 'did:imajin:kai');
    expect(kai.activeGrants).toBe(1);
    expect(kai.revokedGrants).toBe(1);
    expect(kai.purposes).toEqual(['age', 'dietary']);
    expect(kai.lastDisclosureAt).toBe('2026-06-15T19:00:00.000Z');

    const mooi = body.contacts.find((c: { did: string }) => c.did === 'did:imajin:mooi');
    expect(mooi.lastDisclosureAt).toBeNull();

    // Recipients with a recent disclosure sort first.
    expect(body.contacts[0].did).toBe('did:imajin:kai');
  });

  it('scopes the grants query to the acting DID (fail-closed)', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:me' } } as any);
    mockWhere.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await getContacts(new Request(URL));
    expect(JSON.stringify(mockWhere.mock.calls[0][0])).toContain('did:imajin:me');
  });
});
