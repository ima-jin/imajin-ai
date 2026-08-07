import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAuth } = vi.hoisted(() => ({ mockRequireAuth: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

import {
  authorizeRelayWrite,
  isRelayWrite,
  isRelayWriteDenied,
  RELAY_WRITER_DID_HEADER,
} from '../auth';

const CALLER_DID = 'did:imajin:caller-abc';
const GROUP_DID = 'did:imajin:group-xyz';

function makeRequest(method: string): Request {
  return new Request('https://test.imajin.ai/registry/relay/proof/v1/operations', { method });
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('authorizeRelayWrite (#454)', () => {
  it('denies an unauthenticated write with the auth error and status', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const result = await authorizeRelayWrite(makeRequest('POST'));

    expect(isRelayWriteDenied(result)).toBe(true);
    expect(result).toEqual({ error: 'Not authenticated', status: 401 });
  });

  it('propagates a 503 when the auth service is unavailable', async () => {
    mockRequireAuth.mockResolvedValue({ error: 'Auth service unavailable', status: 503 });

    const result = await authorizeRelayWrite(makeRequest('POST'));

    expect(result).toEqual({ error: 'Auth service unavailable', status: 503 });
  });

  it('authorizes a verified DID and returns it', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: CALLER_DID } });

    const result = await authorizeRelayWrite(makeRequest('POST'));

    expect(isRelayWriteDenied(result)).toBe(false);
    expect(result).toEqual({ did: CALLER_DID, callerDid: CALLER_DID });
  });

  it('resolves delegation: the effective DID wins over the caller DID', async () => {
    mockRequireAuth.mockResolvedValue({
      identity: { id: CALLER_DID, actingAs: GROUP_DID },
    });

    const result = await authorizeRelayWrite(makeRequest('PUT'));

    expect(result).toEqual({ did: GROUP_DID, callerDid: CALLER_DID });
  });
});

describe('RELAY_WRITER_DID_HEADER', () => {
  it('is the audit header name forwarded to the relay', () => {
    expect(RELAY_WRITER_DID_HEADER).toBe('x-imajin-relay-writer');
  });
});
