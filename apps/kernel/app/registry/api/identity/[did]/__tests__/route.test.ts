import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockDbSelect,
  mockSelectLimit,
  mockGetChain,
  mockHexToMultibase,
} = vi.hoisted(() => {
  const mockSelectLimit    = vi.fn().mockResolvedValue([]);
  const mockSelectWhere    = vi.fn(() => ({ limit: mockSelectLimit }));
  const mockSelectFrom     = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect       = vi.fn(() => ({ from: mockSelectFrom }));

  const mockGetChain       = vi.fn().mockResolvedValue(null);
  const mockHexToMultibase = vi.fn((hex: string) => `z6Mk${hex.slice(0, 6)}`);

  return { mockDbSelect, mockSelectLimit, mockGetChain, mockHexToMultibase };
});

vi.mock('@/src/db', () => ({
  db: { select: mockDbSelect },
  identities: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
}));

vi.mock('@imajin/auth', () => ({
  hexToMultibase: mockHexToMultibase,
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => new Headers(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/auth/dfos', () => ({
  getChainByImajinDid: mockGetChain,
}));

// ─── Subject under test ──────────────────────────────────────────────────────

import { GET, OPTIONS } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CLAIMED_DID   = 'did:imajin:claimedabc123';
const SOFT_DID      = 'did:imajin:softxyz456';
const UNKNOWN_DID   = 'did:imajin:notexist789';
const CLAIMED_KEY_HEX = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const BASE_URL        = 'https://test.imajin.ai/registry/api/identity';

const CLAIMED_IDENTITY = {
  id: CLAIMED_DID,
  publicKey: CLAIMED_KEY_HEX,
  scope: 'actor',
  subtype: 'human',
  tier: 'full',
};

const SOFT_IDENTITY = {
  id: SOFT_DID,
  publicKey: 'soft_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456',
  scope: 'actor',
  subtype: 'human',
  tier: 'soft',
};

function makeRequest(did: string): Request {
  return new Request(`${BASE_URL}/${encodeURIComponent(did)}`);
}

function paramsFor(did: string) {
  return { params: Promise.resolve({ did: encodeURIComponent(did) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([]);
  mockGetChain.mockResolvedValue(null);
  mockHexToMultibase.mockImplementation((hex: string) => `z6Mk${hex.slice(0, 6)}`);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /registry/api/identity/:did — public DID resolver (#1443)', () => {
  describe('CORS preflight', () => {
    it('OPTIONS returns 204 with cors headers', async () => {
      const res = await OPTIONS(makeRequest(CLAIMED_DID) as Parameters<typeof OPTIONS>[0]);
      expect(res.status).toBe(204);
    });
  });

  describe('unknown DID', () => {
    it('returns 404', async () => {
      mockSelectLimit.mockResolvedValueOnce([]);
      const res = await GET(makeRequest(UNKNOWN_DID) as Parameters<typeof GET>[0], paramsFor(UNKNOWN_DID));
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('DID not found');
    });
  });

  describe('invalid DID prefix', () => {
    it('returns 400 for non-did:imajin prefix', async () => {
      const res = await GET(makeRequest('did:web:example.com') as Parameters<typeof GET>[0], paramsFor('did:web:example.com'));
      expect(res.status).toBe(400);
    });
  });

  describe('soft/stub DID', () => {
    beforeEach(() => {
      mockSelectLimit.mockResolvedValueOnce([SOFT_IDENTITY]);
    });

    it('returns 200 with verifiable:false and stub:true', async () => {
      const res = await GET(makeRequest(SOFT_DID) as Parameters<typeof GET>[0], paramsFor(SOFT_DID));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.did).toBe(SOFT_DID);
      expect(body.tier).toBe('soft');
      expect(body.verifiable).toBe(false);
      expect(body.stub).toBe(true);
    });

    it('does NOT include a publicKey or verificationMethod', async () => {
      const res = await GET(makeRequest(SOFT_DID) as Parameters<typeof GET>[0], paramsFor(SOFT_DID));
      const body = await res.json() as Record<string, unknown>;
      expect(body.publicKey).toBeUndefined();
      expect(body.verificationMethod).toBeUndefined();
    });

    it('does NOT call getChainByImajinDid (no chain lookup for stubs)', async () => {
      await GET(makeRequest(SOFT_DID) as Parameters<typeof GET>[0], paramsFor(SOFT_DID));
      expect(mockGetChain).not.toHaveBeenCalled();
    });
  });

  describe('claimed identity', () => {
    beforeEach(() => {
      mockSelectLimit.mockResolvedValueOnce([CLAIMED_IDENTITY]);
    });

    it('returns 200', async () => {
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      expect(res.status).toBe(200);
    });

    it('includes W3C DID Document context', async () => {
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      const body = await res.json() as Record<string, unknown>;
      expect((body['@context'] as string[]).includes('https://www.w3.org/ns/did/v1')).toBe(true);
    });

    it('includes verificationMethod with publicKeyMultibase', async () => {
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      const body = await res.json() as Record<string, unknown>;
      const methods = body.verificationMethod as Array<Record<string, unknown>>;
      expect(methods).toHaveLength(1);
      expect(methods[0].type).toBe('Ed25519VerificationKey2020');
      expect(typeof methods[0].publicKeyMultibase).toBe('string');
      expect((methods[0].publicKeyMultibase as string).startsWith('z')).toBe(true);
      expect(methods[0].controller).toBe(CLAIMED_DID);
    });

    it('includes authentication and assertionMethod references', async () => {
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      const body = await res.json() as Record<string, unknown>;
      const keyId = `${CLAIMED_DID}#key-1`;
      expect(body.authentication).toEqual([keyId]);
      expect(body.assertionMethod).toEqual([keyId]);
    });

    it('includes resolve.ts compat fields (did, publicKey, type, tier)', async () => {
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      const body = await res.json() as Record<string, unknown>;
      expect(body.did).toBe(CLAIMED_DID);
      expect(body.publicKey).toBe(CLAIMED_KEY_HEX);
      expect(body.type).toBe('actor');
      expect(body.tier).toBe('full');
    });

    it('does NOT include PII fields (name, handle, metadata, grants)', async () => {
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      const body = await res.json() as Record<string, unknown>;
      expect(body.name).toBeUndefined();
      expect(body.handle).toBeUndefined();
      expect(body.metadata).toBeUndefined();
      expect(body.controllers).toBeUndefined();
      expect(body.contactEmail).toBeUndefined();
    });

    it('includes DFOS chain hints when chain exists', async () => {
      mockGetChain.mockResolvedValueOnce({
        dfosDid: 'did:dfos:xyz',
        headCid: 'bafycidabc',
        keyCount: 2,
      });
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      const body = await res.json() as Record<string, unknown>;
      expect(body.dfosDid).toBe('did:dfos:xyz');
      expect(body['imajin:chainHead']).toBe('bafycidabc');
      expect(body['imajin:keyCount']).toBe(2);
    });

    it('omits DFOS chain fields when no chain exists', async () => {
      mockGetChain.mockResolvedValueOnce(null);
      const res = await GET(makeRequest(CLAIMED_DID) as Parameters<typeof GET>[0], paramsFor(CLAIMED_DID));
      const body = await res.json() as Record<string, unknown>;
      expect(body.dfosDid).toBeUndefined();
      expect(body['imajin:chainHead']).toBeUndefined();
    });
  });
});
