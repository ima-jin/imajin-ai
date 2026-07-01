import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const mockWhere = vi.fn();
const mockFrom = vi.fn(() => ({ where: mockWhere }));

vi.mock('@/src/db', () => ({
  db: { select: vi.fn(() => ({ from: mockFrom })) },
  consentGrants: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id),
}));

import { requireAuth } from '@imajin/auth';
import { getGrants } from '../routes/grants';

const URL = 'https://test.imajin.ai/api/broker/grants';

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/broker/grants', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Nope', status: 401 } as any);
    const res = await getGrants(new Request(URL));
    expect(res.status).toBe(401);
  });

  it('groups by purpose, unions fields, counts active/revoked recipients', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: { id: 'did:imajin:me' } } as any);
    const grants = [
      { grantedTo: 'did:imajin:kai', grantedToClass: null, purpose: 'dietary', allowedFields: ['diet'], status: 'active', expiresAt: null },
      { grantedTo: 'did:imajin:hotel', grantedToClass: null, purpose: 'dietary', allowedFields: ['diet', 'allergies'], status: 'revoked', expiresAt: null },
      { grantedTo: 'did:imajin:mooi', grantedToClass: null, purpose: 'age', allowedFields: ['age_over_18'], status: 'active', expiresAt: null },
    ];
    mockWhere.mockResolvedValueOnce(grants);

    const res = await getGrants(new Request(URL));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grants).toHaveLength(2);

    const dietary = body.grants.find((g: { purpose: string }) => g.purpose === 'dietary');
    expect(dietary.fields).toEqual(['allergies', 'diet']);
    expect(dietary.activeContacts).toBe(1);
    expect(dietary.revokedContacts).toBe(1);
    expect(dietary.contacts).toEqual(['did:imajin:hotel', 'did:imajin:kai']);

    // Purposes are sorted alphabetically: age before dietary.
    expect(body.grants[0].purpose).toBe('age');
  });
});
