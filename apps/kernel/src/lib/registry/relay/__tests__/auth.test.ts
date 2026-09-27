import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth, mockVerifyDfosWrite, mockParseDfosAuthorization } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockVerifyDfosWrite: vi.fn(),
  mockParseDfosAuthorization: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('../dfos-write-auth', () => ({
  parseDfosAuthorization: mockParseDfosAuthorization,
  verifyDfosWrite: mockVerifyDfosWrite,
}));

import {
  authorizeRelayWrite,
  isRelayWrite,
  isRelayWriteDenied,
  RELAY_WRITER_DID_HEADER,
} from '../auth';

const CALLER_DID = 'did:imajin:caller-abc';
const GROUP_DID = 'did:imajin:group-xyz';
const PEER_DID = 'did:dfos:peer-abc';

const dfosDeps = {
  dfos: {
    identities: { resolveAuthKeys: vi.fn() },
    getAudience: vi.fn(),
  },
};

function makeRequest(method: string, headers?: Record<string, string>): Request {
  return new Request('https://test.imajin.ai/registry/relay/proof/v1/operations', { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockParseDfosAuthorization.mockReturnValue(null);
});

describe('isRelayWrite (#454)', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('treats %s as a write', (method) => {
    expect(isRelayWrite(method)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('treats %s as a read', (method) => {
    expect(isRelayWrite(method)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRelayWrite('post')).toBe(true);
    expect(isRelayWrite('get')).toBe(false);
  });
});

describe('authorizeRelayWrite — Imajin auth path (#454)', () => {
  it('denies an unauthenticated write with the auth error and status', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const result = await authorizeRelayWrite(makeRequest('POST'), dfosDeps);

    expect(isRelayWriteDenied(result)).toBe(true);
    expect(result).toEqual({ error: 'Not authenticated', status: 401 });
  });

  it('propagates a 503 when the auth service is unavailable', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Auth service unavailable', status: 503 });

    const result = await authorizeRelayWrite(makeRequest('POST'), dfosDeps);

    expect(result).toEqual({ error: 'Auth service unavailable', status: 503 });
  });

  it('authorizes a verified DID and returns it', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: CALLER_DID } });

    const result = await authorizeRelayWrite(makeRequest('POST'), dfosDeps);

    expect(isRelayWriteDenied(result)).toBe(false);
    expect(result).toEqual({ did: CALLER_DID, callerDid: CALLER_DID });
  });

  it('resolves delegation: the effective DID wins over the caller DID', async () => {
    mockRequireAuth.mockResolvedValue({
      identity: { id: CALLER_DID, actingAs: GROUP_DID },
    });

    const result = await authorizeRelayWrite(makeRequest('PUT'), dfosDeps);

    expect(result).toEqual({ did: GROUP_DID, callerDid: CALLER_DID });
  });

  it('never calls verifyDfosWrite when no DFOS scheme is present', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: CALLER_DID } });

    await authorizeRelayWrite(makeRequest('POST'), dfosDeps);

    expect(mockVerifyDfosWrite).not.toHaveBeenCalled();
  });
});

describe('authorizeRelayWrite — DFOS proof path (#2132)', () => {
  it('is authoritative: a present DFOS scheme never falls through to requireAuth', async () => {
    mockParseDfosAuthorization.mockReturnValue('proof-token');
    mockVerifyDfosWrite.mockResolvedValue({ ok: true, did: PEER_DID });

    await authorizeRelayWrite(makeRequest('POST', { authorization: 'DFOS proof-token' }), dfosDeps);

    expect(mockRequireAuth).not.toHaveBeenCalled();
    expect(mockVerifyDfosWrite).toHaveBeenCalledWith('proof-token', dfosDeps.dfos);
  });

  it('authorizes an attested peer, using the peer DID as both did and callerDid', async () => {
    mockParseDfosAuthorization.mockReturnValue('proof-token');
    mockVerifyDfosWrite.mockResolvedValue({ ok: true, did: PEER_DID });

    const result = await authorizeRelayWrite(makeRequest('POST', { authorization: 'DFOS proof-token' }), dfosDeps);

    expect(isRelayWriteDenied(result)).toBe(false);
    expect(result).toEqual({ did: PEER_DID, callerDid: PEER_DID });
  });

  it('denies an invalid/expired/replayed proof with 401, regardless of attestation', async () => {
    mockParseDfosAuthorization.mockReturnValue('bad-token');
    mockVerifyDfosWrite.mockResolvedValue({ ok: false, error: 'invalid_proof', status: 401 });

    const result = await authorizeRelayWrite(makeRequest('POST', { authorization: 'DFOS bad-token' }), dfosDeps);

    expect(result).toEqual({ error: 'invalid_proof', status: 401 });
  });

  it('denies a valid proof from a non-attested peer with 403', async () => {
    mockParseDfosAuthorization.mockReturnValue('good-token');
    mockVerifyDfosWrite.mockResolvedValue({ ok: false, error: 'peer_not_attested', status: 403 });

    const result = await authorizeRelayWrite(makeRequest('POST', { authorization: 'DFOS good-token' }), dfosDeps);

    expect(result).toEqual({ error: 'peer_not_attested', status: 403 });
  });
});

describe('RELAY_WRITER_DID_HEADER', () => {
  it('is the audit header name forwarded to the relay', () => {
    expect(RELAY_WRITER_DID_HEADER).toBe('x-imajin-relay-writer');
  });
});
