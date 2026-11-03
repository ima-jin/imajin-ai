import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ app: vi.fn(), session: vi.fn() }));
vi.mock('@imajin/auth', () => ({
  requireAppAuth: h.app, requireAuth: h.session,
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));
import { warpActingDid } from '../route-context';
import { callerArguments } from '@/src/lib/kernel/connection-principal-policy';

const AGENT = 'did:imajin:agent';
const HUMAN = 'did:imajin:human';
const ORG = 'did:imajin:org';
const request = (headers: Record<string, string> = {}) => new NextRequest('https://kernel.test/warp/api/runs', { headers });

beforeEach(() => {
  vi.resetAllMocks();
  h.session.mockResolvedValue({ identity: { id: HUMAN, scope: 'actor', subtype: 'human' } });
});
it('keeps personal-session ownership and delegated-session actor identity distinct', async () => {
  expect(await warpActingDid(request(), {})).toEqual({ did: HUMAN });
  h.session.mockResolvedValue({ identity: { id: HUMAN, scope: 'actor', subtype: 'human', actingAs: ORG } });
  expect(await warpActingDid(request(), {})).toEqual({ did: ORG, caller: { actorDid: HUMAN, actingAs: ORG } });
  expect(h.session).toHaveBeenCalledWith(expect.anything(), { service: 'warp', allowMemberActAs: true });
});
it('keeps the signed agent DID when selecting an assigned org with app+jwt and x-acting-as', async () => {
  h.app.mockResolvedValue({ appAuth: { appDid: 'did:imajin:app', userDid: AGENT, actingAs: ORG } });
  const req = request({ authorization: 'Bearer fixture-app-token', 'x-acting-as': ORG });
  expect(await warpActingDid(req, {})).toEqual({ did: ORG, caller: { actorDid: AGENT, actingAs: ORG } });
  expect(h.app).toHaveBeenCalledWith(req, { scope: 'warp:dispatch', service: 'warp', allowMemberActAs: true });
  expect(h.session).not.toHaveBeenCalled();
});
it('preserves onBehalfOf a human separately from the selected org', async () => {
  h.app.mockResolvedValue({ appAuth: { userDid: AGENT, actingFor: HUMAN, actingAs: ORG } });
  expect(await warpActingDid(request({ authorization: 'Bearer fixture' }), {})).toEqual({
    did: ORG, caller: { actorDid: AGENT, actingFor: HUMAN, actingAs: ORG },
  });
});
it('does not read unverified selectors into the authenticated context', async () => {
  h.app.mockResolvedValue({ appAuth: { userDid: AGENT } });
  expect(await warpActingDid(request({ authorization: 'Bearer fixture', 'x-acting-as': ORG }), {}))
    .toEqual({ did: AGENT, caller: { actorDid: AGENT } });
});
it.each([401, 403, 503])('never falls back to a personal session after a rejected app credential (%i)', async status => {
  h.app.mockResolvedValue({ error: 'App credential rejected', status, notAppToken: false });
  const result = await warpActingDid(request({ authorization: 'Bearer fixture' }), {});
  expect('response' in result && result.response.status).toBe(status);
  expect(h.session).not.toHaveBeenCalled();
});
it.each([{ userDid: '' }, { userDid: AGENT, isServiceToken: true }])('refuses service tokens without an actor credential: %j', async appAuth => {
  h.app.mockResolvedValue({ appAuth });
  const result = await warpActingDid(request({ authorization: 'Bearer fixture' }), {});
  expect('response' in result && result.response.status).toBe(403);
});
it('allows a genuine session bearer, and denies a missing session', async () => {
  h.app.mockResolvedValue({ error: 'Not an app token', status: 401, notAppToken: true });
  expect(await warpActingDid(request({ authorization: 'Bearer session-fixture' }), {})).toEqual({ did: HUMAN });
  h.session.mockResolvedValue({ error: 'No session', status: 401 });
  const result = await warpActingDid(request(), {});
  expect('response' in result && result.response.status).toBe(401);
});
it('retains self-agent context and optional credential arguments without changing human call signatures', async () => {
  h.session.mockResolvedValue({ identity: { id: AGENT, scope: 'actor', subtype: 'agent' } });
  expect(await warpActingDid(request(), {})).toEqual({ did: AGENT, caller: { actorDid: AGENT } });
  expect(callerArguments(undefined)).toEqual([]);
  expect(callerArguments({ actorDid: AGENT })).toEqual([{ actorDid: AGENT }]);
});
