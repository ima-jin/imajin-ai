import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockRequireAuth,
  mockPublish,
  mockConsentInsertReturning,
  mockConsentInsertValues,
  mockConsentInsert,
} = vi.hoisted(() => {
  const mockRequireAuth = vi.fn();
  const mockPublish     = vi.fn().mockResolvedValue(undefined);

  const MOCK_GRANT = {
    id: 'consent-test-id',
    subject: 'did:imajin:traveler',
    issuer: 'did:imajin:app',
    grantedTo: 'did:imajin:hotel',
    purpose: 'dietary',
    allowedFields: ['diet'],
    mode: 'attestation',
    status: 'active',
    consentRef: 'cg-test-id',
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockConsentInsertReturning = vi.fn().mockResolvedValue([MOCK_GRANT]);
  const mockConsentInsertValues    = vi.fn(() => ({ returning: mockConsentInsertReturning }));
  const mockConsentInsert          = vi.fn(() => ({ values: mockConsentInsertValues }));

  return {
    mockRequireAuth,
    mockPublish,
    mockConsentInsertReturning,
    mockConsentInsertValues,
    mockConsentInsert,
    MOCK_GRANT,
  };
});

vi.mock('@/src/db', () => ({
  db: { insert: mockConsentInsert, select: vi.fn(), update: vi.fn() },
  consentGrants: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq:  (...args: unknown[]) => ({ eq: args }),
  desc: (col: unknown) => ({ desc: col }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@imajin/logger', () => ({
  withLogger: (_: string, fn: unknown) => fn,
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}-test-id`,
}));

// ─── Subject under test ──────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const APP_DID      = 'did:imajin:app-tripian';
const TRAVELER_DID = 'did:imajin:traveler-456';
const HOTEL_DID    = 'did:imajin:hotel-789';
const BASE_URL     = 'https://test.imajin.ai/api/broker/consent';

const CONSENT_BODY = {
  subject: TRAVELER_DID,
  grantedTo: HOTEL_DID,
  purpose: 'dietary',
  allowedFields: ['diet', 'allergies'],
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
  mockConsentInsertReturning.mockResolvedValue([{
    id: 'consent-test-id',
    subject: TRAVELER_DID,
    issuer: APP_DID,
    grantedTo: HOTEL_DID,
    purpose: 'dietary',
    allowedFields: ['diet', 'allergies'],
    mode: 'attestation',
    status: 'active',
    consentRef: 'cg-test-id',
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }]);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/broker/consent — acting-for path (#1442)', () => {
  // Scenario 2a: partner sends X-Acting-For; requireAuth sets actingFor
  describe('acting-for: partner writes consent on traveler behalf', () => {
    beforeEach(() => {
      // requireAuth validates the agent grant and populates actingFor
      mockRequireAuth.mockResolvedValue({
        identity: { id: APP_DID, actingFor: TRAVELER_DID },
      });
    });

    it('accepts subject = traveler DID and returns 201', async () => {
      const res = await POST(makeRequest(CONSENT_BODY));
      expect(res.status).toBe(201);
    });

    it('stores issuer = app DID in the consent_grants row', async () => {
      await POST(makeRequest(CONSENT_BODY));

      expect(mockConsentInsert).toHaveBeenCalledOnce();
      const row = mockConsentInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(row.subject).toBe(TRAVELER_DID);
      expect(row.issuer).toBe(APP_DID);
    });

    it('publishes broker.consent.created with issuer = app DID', async () => {
      await POST(makeRequest(CONSENT_BODY));

      expect(mockPublish).toHaveBeenCalledOnce();
      const [, payload] = mockPublish.mock.calls[0] as [string, { issuer: string; subject: string }];
      expect(payload.issuer).toBe(APP_DID);
      expect(payload.subject).toBe(TRAVELER_DID);
    });

    it('rejects when subject does not match the traveler DID', async () => {
      const res = await POST(makeRequest({ ...CONSENT_BODY, subject: APP_DID }));
      expect(res.status).toBe(403);
    });
  });

  // Scenario 1 (control): caller is the subject — self-grant path unchanged
  describe('self-grant: subject === caller', () => {
    beforeEach(() => {
      mockRequireAuth.mockResolvedValue({
        identity: { id: TRAVELER_DID }, // no actingFor
      });
    });

    it('accepts subject = caller DID and returns 201', async () => {
      const res = await POST(makeRequest(CONSENT_BODY));
      expect(res.status).toBe(201);
    });

    it('stores issuer = null (self-grant) in the row', async () => {
      await POST(makeRequest(CONSENT_BODY));

      const row = mockConsentInsertValues.mock.calls[0][0] as Record<string, unknown>;
      expect(row.subject).toBe(TRAVELER_DID);
      expect(row.issuer).toBeNull();
    });

    it('rejects when subject does not match caller DID', async () => {
      const res = await POST(makeRequest({ ...CONSENT_BODY, subject: 'did:imajin:someone-else' }));
      expect(res.status).toBe(403);
    });
  });

  // Scenario 3: revocation — agent grant removed → requireAuth denies acting-for
  describe('revocation: agent grant removed → acting-for rejected', () => {
    it('returns 401 when requireAuth rejects the acting-for (agent grant revoked)', async () => {
      // When the identity_members row has removedAt set, validateActingAs returns
      // { valid: false }, causing requireAuth to return a 403 error.
      // The consent route maps any auth error to 401.
      mockRequireAuth.mockResolvedValue({
        error: 'Not authorized to act for this identity',
        status: 403,
      });

      const res = await POST(makeRequest(CONSENT_BODY));
      expect(res.status).toBe(401);
      expect(mockConsentInsert).not.toHaveBeenCalled();
    });
  });
});
