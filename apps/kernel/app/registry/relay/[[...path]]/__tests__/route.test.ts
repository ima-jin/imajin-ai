import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// vi.mock factories are hoisted; everything they reference must come from
// vi.hoisted. The env vars are set here too — route.ts reads them at module
// scope, which runs after hoisted blocks but before any test body.

const {
  mockRelayFetch,
  mockCreateCustomRelay,
  mockRequireAuth,
  mockGetIdentityChain,
  mockDecodeJwsUnsafe,
  mockDecodeMultikey,
  mockVerifyAuthToken,
  mockIsRelayPeerAttested,
} = vi.hoisted(() => {
    process.env.RELAY_STORE = 'memory';
    process.env.RELAY_DID = 'did:dfos:relay-under-test';
    process.env.RELAY_PROFILE_JWS = 'jws.relay.profile';

    return {
      mockRelayFetch: vi.fn(),
      mockCreateCustomRelay: vi.fn(),
      mockRequireAuth: vi.fn(),
      // A chain already exists for RELAY_DID, so initRelay takes the
      // env-identity path and never needs the bootstrap/well-known dance.
      mockGetIdentityChain: vi.fn().mockResolvedValue({ did: 'did:dfos:relay-under-test' }),
      mockDecodeJwsUnsafe: vi.fn(),
      mockDecodeMultikey: vi.fn(),
      mockVerifyAuthToken: vi.fn(),
      mockIsRelayPeerAttested: vi.fn(),
    };
  });

vi.mock('@metalabel/dfos-web-relay', () => ({
  MemoryRelayStore: class {
    getIdentityChain = mockGetIdentityChain;
  },
}));

vi.mock('@/src/lib/registry/relay/postgres-store', () => ({
  PostgresRelayStore: class {
    getIdentityChain = mockGetIdentityChain;
  },
}));

vi.mock('@/src/lib/registry/relay/create-relay', () => ({
  createCustomRelay: mockCreateCustomRelay,
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));

vi.mock('@/src/db', () => ({
  db: {
    // No peers configured and no persisted relay_config row.
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    }),
  },
}));

vi.mock('@/src/db/schemas/relay', () => ({
  relayConfig: { id: 'id' },
  relayPeers: { enabled: 'enabled' },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

// DFOS proof verification (#2132) — real dfos-write-auth.ts / auth.ts wiring,
// mocked only at the crypto/protocol boundary + the attestation gate.
vi.mock('@metalabel/dfos-protocol/crypto', () => ({
  decodeJwsUnsafe: mockDecodeJwsUnsafe,
}));
vi.mock('@metalabel/dfos-protocol/chain', () => ({
  decodeMultikey: mockDecodeMultikey,
}));
vi.mock('@metalabel/dfos-protocol/credentials', () => ({
  verifyAuthToken: mockVerifyAuthToken,
}));
vi.mock('@/src/lib/registry/relay/peer-attestations', () => ({
  isRelayPeerAttested: mockIsRelayPeerAttested,
}));

// ─── Subject under test ─────────────────────────────────────────────────────────

import { GET, POST, PUT, PATCH, DELETE } from '../route';

// ─── Fixtures ─────────────────────────────────────────────────────────

const WRITER_DID = 'did:imajin:writer-abc';
const GROUP_DID = 'did:imajin:group-xyz';
const WRITER_HEADER = 'x-imajin-relay-writer';
const PEER_DID = 'did:dfos:peer-abc';
const PEER_KEY_ID = 'key_peer';
const RELAY_DID_UNDER_TEST = 'did:dfos:relay-under-test';

const OPERATIONS_URL = 'https://test.imajin.ai/registry/relay/proof/v1/operations';
const LOG_URL = 'https://test.imajin.ai/registry/relay/proof/v1/log?limit=10';

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

/** The Request the handler forwarded to the relay app. */
function forwardedRequest(): Request {
  return mockRelayFetch.mock.calls[0][0] as Request;
}

type RouteHandler = (request: Request) => Promise<Response>;

const WRITE_HANDLERS: Array<[string, RouteHandler]> = [
  ['POST', POST],
  ['PUT', PUT],
  ['PATCH', PATCH],
  ['DELETE', DELETE],
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetIdentityChain.mockImplementation(async (did: string) => {
    if (did === RELAY_DID_UNDER_TEST) return { did: RELAY_DID_UNDER_TEST };
    if (did === PEER_DID) {
      return { state: { isDeleted: false, authKeys: [{ id: PEER_KEY_ID, publicKeyMultibase: 'z6Mkexample' }] } };
    }
    return undefined;
  });
  mockCreateCustomRelay.mockResolvedValue({
    app: { fetch: mockRelayFetch },
    did: 'did:dfos:relay-under-test',
    syncFromPeers: vi.fn().mockResolvedValue(undefined),
  });
  mockRelayFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });

  mockDecodeJwsUnsafe.mockReturnValue({ header: { kid: `${PEER_DID}#${PEER_KEY_ID}` }, payload: {} });
  mockDecodeMultikey.mockReturnValue({ keyBytes: new Uint8Array([1, 2, 3]), codec: 0xed });
  mockVerifyAuthToken.mockReturnValue({ iss: PEER_DID, aud: RELAY_DID_UNDER_TEST, exp: 1, iat: 0, kid: `${PEER_DID}#${PEER_KEY_ID}` });
  mockIsRelayPeerAttested.mockResolvedValue(true);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('relay proxy authZ (#454)', () => {
  describe('reads stay open', () => {
    it('proxies an unauthenticated GET without calling requireAuth', async () => {
      const res = await GET(makeRequest(LOG_URL));

      expect(res.status).toBe(200);
      expect(mockRequireAuth).not.toHaveBeenCalled();
      expect(mockRelayFetch).toHaveBeenCalledOnce();
    });

    it('strips the relay path prefix and preserves the query string', async () => {
      await GET(makeRequest(LOG_URL));

      const url = new URL(forwardedRequest().url);
      expect(url.pathname).toBe('/proof/v1/log');
      expect(url.search).toBe('?limit=10');
    });

    it('never lets a client forge the writer header on a read', async () => {
      await GET(makeRequest(LOG_URL, { headers: { [WRITER_HEADER]: 'did:imajin:spoofed' } }));

      expect(forwardedRequest().headers.get(WRITER_HEADER)).toBeNull();
    });
  });

  describe('writes require a verified DID', () => {
    it.each(WRITE_HANDLERS)('rejects an unauthenticated %s with 401', async (method, handler) => {
      const res = await handler(makeRequest(OPERATIONS_URL, { method }));

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Not authenticated' });
      // The relay must never see an unauthorized write.
      expect(mockRelayFetch).not.toHaveBeenCalled();
    });

    it('propagates a 503 when the auth service is unavailable', async () => {
      mockRequireAuth.mockResolvedValue({ error: 'Auth service unavailable', status: 503 });

      const res = await POST(makeRequest(OPERATIONS_URL, { method: 'POST' }));

      expect(res.status).toBe(503);
      expect(mockRelayFetch).not.toHaveBeenCalled();
    });

    it('returns 403 when delegation is rejected', async () => {
      mockRequireAuth.mockResolvedValue({
        error: 'Not authorized to act as this group',
        status: 403,
      });

      const res = await POST(makeRequest(OPERATIONS_URL, { method: 'POST' }));

      expect(res.status).toBe(403);
      expect(mockRelayFetch).not.toHaveBeenCalled();
    });
  });

  describe('authenticated writes succeed', () => {
    it('proxies a POST from a verified DID', async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: WRITER_DID } });

      const res = await POST(
        makeRequest(OPERATIONS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: ['jws.token'] }),
        }),
      );

      expect(res.status).toBe(200);
      expect(mockRequireAuth).toHaveBeenCalledOnce();
      expect(mockRelayFetch).toHaveBeenCalledOnce();

      const forwarded = forwardedRequest();
      expect(forwarded.method).toBe('POST');
      expect(new URL(forwarded.url).pathname).toBe('/proof/v1/operations');
      expect(await forwarded.text()).toBe(JSON.stringify({ operations: ['jws.token'] }));
    });

    it('forwards the authenticated DID for audit', async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: WRITER_DID } });

      await PUT(
        makeRequest('https://test.imajin.ai/registry/relay/content/abc/blob/cid1', {
          method: 'PUT',
          body: 'bytes',
        }),
      );

      expect(forwardedRequest().headers.get(WRITER_HEADER)).toBe(WRITER_DID);
    });

    it('forwards the effective DID when acting as a group', async () => {
      mockRequireAuth.mockResolvedValue({
        identity: { id: WRITER_DID, actingAs: GROUP_DID },
      });

      await POST(makeRequest(OPERATIONS_URL, { method: 'POST', body: '{}' }));

      expect(forwardedRequest().headers.get(WRITER_HEADER)).toBe(GROUP_DID);
    });

    it('overwrites a client-supplied writer header with the verified DID', async () => {
      mockRequireAuth.mockResolvedValue({ identity: { id: WRITER_DID } });

      await POST(
        makeRequest(OPERATIONS_URL, {
          method: 'POST',
          headers: { [WRITER_HEADER]: 'did:imajin:spoofed' },
          body: '{}',
        }),
      );

      expect(forwardedRequest().headers.get(WRITER_HEADER)).toBe(WRITER_DID);
    });
  });

  describe('DFOS proof writes (#2132)', () => {
    function dfosRequest(): Request {
      return makeRequest(OPERATIONS_URL, {
        method: 'POST',
        headers: { authorization: 'DFOS proof-token' },
        body: '{}',
      });
    }

    it('never calls requireAuth when a DFOS-scheme header is present', async () => {
      await POST(dfosRequest());

      expect(mockRequireAuth).not.toHaveBeenCalled();
    });

    it('proxies a write from an attested peer and forwards the peer DID for audit', async () => {
      const res = await POST(dfosRequest());

      expect(res.status).toBe(200);
      expect(mockRelayFetch).toHaveBeenCalledOnce();
      expect(forwardedRequest().headers.get(WRITER_HEADER)).toBe(PEER_DID);
      // Audience resolved from RELAY_DID env, identity resolved from the store.
      expect(mockVerifyAuthToken).toHaveBeenCalledWith(
        expect.objectContaining({ audience: RELAY_DID_UNDER_TEST }),
      );
      expect(mockIsRelayPeerAttested).toHaveBeenCalledWith(PEER_DID);
    });

    it('rejects a cryptographically invalid proof with 401, never touching the relay', async () => {
      mockVerifyAuthToken.mockImplementation(() => {
        throw new Error('bad signature');
      });

      const res = await POST(dfosRequest());

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'invalid_proof' });
      expect(mockRelayFetch).not.toHaveBeenCalled();
      expect(mockIsRelayPeerAttested).not.toHaveBeenCalled();
    });

    it('rejects a valid proof from a non-attested peer with 403', async () => {
      mockIsRelayPeerAttested.mockResolvedValue(false);

      const res = await POST(dfosRequest());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'peer_not_attested' });
      expect(mockRelayFetch).not.toHaveBeenCalled();
    });
  });
});
