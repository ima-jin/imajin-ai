import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentSigningPayload } from '../document-signing-payload';
const mocks = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  getChainByImajinDidMock: vi.fn(),
  verifyChainMock: vi.fn(),
  signSyncMock: vi.fn(),
  parseDocumentSigningPayloadMock: vi.fn(),
}));

vi.mock('@/src/lib/auth/middleware', () => ({
  requireAuth: mocks.requireAuthMock,
}));

vi.mock('@/src/lib/auth/dfos', () => ({
  getChainByImajinDid: mocks.getChainByImajinDidMock,
}));

vi.mock('@imajin/dfos', () => ({
  verifyChain: mocks.verifyChainMock,
}));

vi.mock('@imajin/auth', () => ({
  crypto: {
    signSync: mocks.signSyncMock,
  },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

vi.mock('@/src/lib/auth/document-signing-payload', async (importOriginal) => ({
  // Keep the real, deterministic builder the test uses to construct payloads;
  // only the parser is stubbed so the route's parse step is controllable.
  ...(await importOriginal<typeof import('../document-signing-payload')>()),
  parseDocumentSigningPayload: mocks.parseDocumentSigningPayloadMock,
}));

import { POST } from '../../../../app/auth/api/identity/[did]/sign/route';

describe('POST /auth/api/identity/[did]/sign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_PRIVATE_KEY = 'a'.repeat(64);
    delete process.env.INTERNAL_API_KEY;
  });

  it('allows authenticated session signing for matching DID and valid payload', async () => {
    mocks.requireAuthMock.mockResolvedValueOnce({ sub: 'did:imajin:alice' });
    mocks.getChainByImajinDidMock.mockResolvedValueOnce({ log: ['cid1'] });
    mocks.verifyChainMock.mockResolvedValueOnce({ isDeleted: false, authKeys: ['key1'] });
    mocks.signSyncMock.mockReturnValueOnce('deadbeefsignature');
    mocks.parseDocumentSigningPayloadMock.mockReturnValueOnce({
      did: 'did:imajin:alice',
      documentHash: 'bafyhash123',
    });

    const payload = buildDocumentSigningPayload('did:imajin:alice', 'bafyhash123');
    const request = new Request('https://test.imajin.ai/auth/api/identity/did%3Aimajin%3Aalice/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });

    const response = await POST(request as any, { params: Promise.resolve({ did: 'did%3Aimajin%3Aalice' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signature).toBe('deadbeefsignature');
    expect(mocks.signSyncMock).toHaveBeenCalledWith(payload, process.env.AUTH_PRIVATE_KEY);
  });

  it('returns 400 when session-auth payload did does not match path did', async () => {
    mocks.requireAuthMock.mockResolvedValueOnce({ sub: 'did:imajin:alice' });
    mocks.parseDocumentSigningPayloadMock.mockReturnValueOnce({
      did: 'did:imajin:bob',
      documentHash: 'bafyhash123',
    });

    const payload = buildDocumentSigningPayload('did:imajin:bob', 'bafyhash123');
    const request = new Request('https://test.imajin.ai/auth/api/identity/did%3Aimajin%3Aalice/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });

    const response = await POST(request as any, { params: Promise.resolve({ did: 'did%3Aimajin%3Aalice' }) });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('payload must include matching did and document_hash');
  });

  it('returns 403 when session DID does not match route DID', async () => {
    mocks.requireAuthMock.mockResolvedValueOnce({ sub: 'did:imajin:alice' });

    const payload = buildDocumentSigningPayload('did:imajin:bob', 'bafyhash123');
    const request = new Request('https://test.imajin.ai/auth/api/identity/did%3Aimajin%3Abob/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });

    const response = await POST(request as any, { params: Promise.resolve({ did: 'did%3Aimajin%3Abob' }) });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Forbidden');
  });
});
