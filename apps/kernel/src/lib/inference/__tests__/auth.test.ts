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
  vi.resetAllMocks();
});

describe('resolveInferenceAuth — x-api-key bearer fallback (#1959)', () => {
  it.each([false, true])('self discovery preserves only verified token scopes (service token: %s)', async serviceToken => {
    const scopes = ['infer:completions', 'warp:dispatch'];
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: OWNER_DID, scopes, isServiceToken: serviceToken },
    });
    const result = await resolveInferenceAuth(makeRequest({
      'x-acting-as': 'did:imajin:unverified', 'x-scopes': 'connectors:mcp:read',
    }), 'infer:completions', true);
    expect(result).toMatchObject({
      ok: true, context: { ownerDid: OWNER_DID, toolAuth: { scopes, serviceToken } },
    });
    if (result.ok) {
      expect(result.context.caller?.actingAs).toBeUndefined();
      expect(result.context.toolAuth?.scopes).not.toBe(scopes);
      expect(result.context.toolAuth?.scopes).not.toContain('connectors:mcp:read');
    }
  });
  it('refuses a rejected app credential even when a valid personal session is available', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid app token', status: 401, notAppToken: false });
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    expect(await resolveInferenceAuth(makeRequest({ authorization: 'Bearer invalid-app', cookie: 'session=fixture' })))
      .toEqual({ ok: false, error: 'Invalid app token', status: 401 });
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });
  it('does not let an app service token assert a principal using an unverified x-acting-for header', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ appAuth: { appDid: APP_DID, userDid: '', isServiceToken: true } });
    expect(await resolveInferenceAuth(makeRequest({ 'x-acting-for': OWNER_DID })))
      .toMatchObject({ ok: false, status: 400 });
  });
  it('carries a verified human-agent delegation and org selector separately', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: 'did:imajin:agent', actingFor: OWNER_DID, actingAs: 'did:imajin:org' },
    });
    expect(await resolveInferenceAuth(makeRequest({}))).toMatchObject({
      ok: true, context: {
        ownerDid: 'did:imajin:org', caller: { actorDid: 'did:imajin:agent', actingFor: OWNER_DID, actingAs: 'did:imajin:org' },
        orgContext: { memberDid: OWNER_DID, orgDid: 'did:imajin:org' },
      },
    });
  });
  it('retains the member separately from a verified app acting org', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: OWNER_DID, actingAs: 'did:imajin:org' },
    });
    expect(await resolveInferenceAuth(makeRequest({ 'x-api-key': 'token', 'x-acting-as': 'did:imajin:org' }))).toEqual({
      ok: true, context: { ownerDid: 'did:imajin:org', appDid: APP_DID, caller: { actorDid: OWNER_DID, actingAs: 'did:imajin:org' }, orgContext: { memberDid: OWNER_DID, orgDid: 'did:imajin:org' } },
    });
  });
  it('retains a verified session member and acting org', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'no app token', status: 401 });
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID, actingAs: 'did:imajin:org' } });
    mockResolveActingDid.mockReturnValueOnce('did:imajin:org');
    expect(await resolveInferenceAuth(makeRequest({}))).toEqual({
      ok: true, context: { ownerDid: 'did:imajin:org', caller: { actorDid: OWNER_DID, actingAs: 'did:imajin:org' }, orgContext: { memberDid: OWNER_DID, orgDid: 'did:imajin:org' } },
    });
  });
  it('never degrades an app act-as or scope denial to session auth', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Not authorized to act as this group', status: 403 });
    expect(await resolveInferenceAuth(makeRequest({}))).toMatchObject({ ok: false, status: 403 });
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });
  it('does not derive org authority from an unverified header', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ appAuth: { appDid: APP_DID, userDid: OWNER_DID } });
    expect(await resolveInferenceAuth(makeRequest({ 'x-acting-as': 'did:imajin:spoof', 'x-acting-for': 'did:imajin:spoof' }))).toEqual({
      ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID, caller: { actorDid: OWNER_DID } },
    });
  });
  it('rejects conflicting verified session act-as and act-for targets', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'no app token', status: 401 });
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID, actingAs: 'did:imajin:org', actingFor: 'did:imajin:other' } });
    mockResolveActingDid.mockReturnValueOnce('did:imajin:other');
    expect(await resolveInferenceAuth(makeRequest({}))).toMatchObject({ ok: false, status: 403 });
  });
  it('authenticates via x-api-key when no Authorization header is present', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: OWNER_DID, scopes: ['infer:completions'], attestationId: 'att_1' },
    });

    const result = await resolveInferenceAuth(makeRequest({ 'x-api-key': 'minted-app-token' }), 'infer:completions');

    expect(result).toEqual({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID, caller: { actorDid: OWNER_DID } } });
    expect(mockRequireAppAuth).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.any(Headers) }),
      { scope: 'infer:completions', service: 'infer', allowMemberActAs: true },
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

    expect(result).toEqual({ ok: true, context: { ownerDid: OWNER_DID, appDid: APP_DID, caller: { actorDid: OWNER_DID } } });
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

    expect(result).toEqual({ ok: false, error: 'Invalid or expired app token', status: 401 });
  });

  it('falls back to session auth when neither Authorization nor x-api-key is present', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Authorization Bearer <app-token>, or X-App-DID + X-App-Authorization headers required', status: 401 });
    mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER_DID } });
    mockResolveActingDid.mockReturnValueOnce(OWNER_DID);

    const result = await resolveInferenceAuth(makeRequest({}), 'infer:completions');

    expect(result).toEqual({ ok: true, context: { ownerDid: OWNER_DID } });
  });
});
