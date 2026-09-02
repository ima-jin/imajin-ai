/**
 * Tests for `resolveInferenceAuth`, focused on the `x-api-key` bearer
 * fallback added for #1959: the Claude Agent SDK / Claude Code CLI
 * authenticate with `x-api-key`, never `Authorization: Bearer`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAppAuth, mockRequireAuth, mockResolveActingDid } = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockResolveActingDid: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mockRequireAppAuth,
  requireAuth: mockRequireAuth,
  resolveActingDid: mockResolveActingDid,
}));

import { resolveInferenceAuth } from '../auth';

const OWNER_DID = 'did:imajin:supplier';
const APP_DID = 'did:imajin:nanoclaw-app';

function makeRequest(headers: Record<string, string>): Request {
  return new Request('https://kernel.test/infer/v1/messages', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveInferenceAuth — x-api-key bearer fallback (#1959)', () => {
  it('authenticates via x-api-key when no Authorization header is present', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: OWNER_DID, scopes: ['infer:completions'], attestationId: 'att_1' },
    });

    const result = await resolveInferenceAuth(makeRequest({ 'x-api-key': 'minted-app-token' }), 'infer:completions');

    expect(result).toEqual({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID } });
    expect(mockRequireAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.any(Headers) }),
      { scope: 'infer:completions' },
    );
    const forwardedRequest = mockRequireAppAuth.mock.calls[0][0] as Request;
    expect(forwardedRequest.headers.get('authorization')).toBe('Bearer minted-app-token');
  });

  it('prefers an existing Authorization header over x-api-key when both are present', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: OWNER_DID, scopes: ['infer:completions'], attestationId: 'att_1' },
    });

    await resolveInferenceAuth(
      makeRequest({ authorization: 'Bearer real-token', 'x-api-key': 'ignored-key' }),
      'infer:completions',
    );

    const forwardedRequest = mockRequireAppAuth.mock.calls[0][0] as Request;
    expect(forwardedRequest.headers.get('authorization')).toBe('Bearer real-token');
  });

  it('still resolves normally via a plain Authorization bearer, with no x-api-key present', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: OWNER_DID, scopes: ['infer:completions'], attestationId: 'att_1' },
    });

    const result = await resolveInferenceAuth(makeRequest({ authorization: 'Bearer real-token' }), 'infer:completions');

    expect(result).toEqual({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID } });
  });

  it('does not mutate the original request object', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: OWNER_DID, scopes: ['infer:completions'], attestationId: 'att_1' },
    });

    const request = makeRequest({ 'x-api-key': 'minted-app-token' });
    await resolveInferenceAuth(request, 'infer:completions');

    expect(request.headers.get('authorization')).toBeNull();
  });

  it('returns 401 when x-api-key does not verify as an app token', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid or expired app token', status: 401, notAppToken: true });
    mockRequireAuth.mockResolvedValueOnce({ error: 'No credentials supplied', status: 401 });

    const result = await resolveInferenceAuth(makeRequest({ 'x-api-key': 'bad-key' }), 'infer:completions');

    expect(result).toEqual({ ok: false, error: 'No credentials supplied', status: 401 });
  });

  it('falls back to session auth when neither Authorization nor x-api-key is present', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required', status: 401 });
    mockRequireAuth.mockResolvedValueOnce({ identity: { did: OWNER_DID } });
    mockResolveActingDid.mockReturnValueOnce(OWNER_DID);

    const result = await resolveInferenceAuth(makeRequest({}), 'infer:completions');

    expect(result).toEqual({ ok: true, context: { ownerDid: OWNER_DID } });
  });
});
