import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verify, session, introspect, binding, select } = vi.hoisted(() => ({
  verify: vi.fn(), session: vi.fn(), introspect: vi.fn(), binding: vi.fn(), select: vi.fn(),
}));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: verify, APP_TOKEN_DEFAULT_AUDIENCE: 'imajin:apps' }));
vi.mock('@imajin/auth', () => ({
  requireAuth: session,
  resolveActingDid: (identity: { id: string; actingAs?: string }) => identity.actingAs ?? identity.id,
}));
vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: introspect }));
vi.mock('@/src/lib/mcp/agent-binding', () => ({ mcpOAuthContext: binding }));
vi.mock('@/src/lib/mcp/oauth-config', () => ({ getMcpResource: () => 'https://kernel.test/mcp' }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => {
    const promise = Promise.resolve(select());
    return Object.assign(promise, { limit: () => promise });
  } }) }) },
  attestations: { id: 'attestationId' },
  identities: { id: 'id', suspendedAt: 'suspendedAt' },
  delegationGrants: { delegatorDid: 'delegatorDid', agentDid: 'agentDid', status: 'status', expiresAt: 'expiresAt' },
}));
import { gitAuthority } from '../git-authority';

const agent = 'did:imajin:agent';
const owner = 'did:imajin:owner';
const other = 'did:imajin:other';
const payload = () => ({
  sub: agent, azp: 'did:imajin:client', scope: 'github:read', aud: 'imajin:apps', attestationId: 'authorization',
});
const authorization = () => ({
  type: 'app.authorized', issuerDid: agent, subjectDid: 'did:imajin:client',
  payload: { scopes: ['github:read'] }, revokedAt: null, expiresAt: null,
});
function req(headers: Record<string, string> = {}, bearer = true) {
  return new Request('https://kernel.test', { headers: { ...(bearer ? { Authorization: 'Bearer synthetic' } : {}), ...headers } });
}
function rows(owners = [owner], identity = { subtype: 'agent' }, auth = authorization()) {
  select.mockReset().mockReturnValueOnce([auth]).mockReturnValueOnce([identity])
    .mockReturnValue(owners.map(ownerDid => ({ ownerDid })));
}
beforeEach(() => {
  vi.resetAllMocks();
  verify.mockResolvedValue(payload());
  session.mockResolvedValue({ error: 'unauthenticated' });
  introspect.mockResolvedValue({ authorized: true, grantId: 'grant' });
  rows();
});

describe('git owner authority', () => {
  it('resolves the unique live scoped grant, never the JWT app registrant', async () => {
    expect(await gitAuthority(req())).toEqual({ actorDid: agent, ownerDid: owner, grantId: 'grant' });
    expect(introspect).toHaveBeenCalledWith(expect.objectContaining({
      agentDid: agent, delegatorDid: owner, capability: 'github:read',
    }));
  });
  it('rechecks each request, so whole-grant/capability revoke, expiry and audience denial take effect', async () => {
    expect(await gitAuthority(req())).toMatchObject({ ownerDid: owner });
    rows();
    introspect.mockResolvedValue({ authorized: false });
    expect(await gitAuthority(req())).toBe(403);
  });
  it('denies an agent with no grants, even if it owns a connector', async () => {
    rows([]);
    expect(await gitAuthority(req())).toBe(403);
  });
  it('requires X-Acting-For with multiple distinct granting owners, deduplicating grants', async () => {
    rows([owner, owner, other]);
    expect(await gitAuthority(req())).toBe(409);
    rows([owner, other]);
    expect(await gitAuthority(req({ 'X-Acting-For': other }))).toMatchObject({ actorDid: agent, ownerDid: other });
    rows([owner, other]);
    expect(await gitAuthority(req({ 'X-Acting-For': 'did:imajin:stranger' }))).toBe(403);
  });
  it('cannot override a consent-bound owner and still requires the multi-owner selector', async () => {
    verify.mockResolvedValue({ ...payload(), actingFor: owner });
    expect(await gitAuthority(req({ 'X-Acting-For': other }))).toBe(403);
    rows([owner, other]);
    expect(await gitAuthority(req())).toBe(409);
    expect(binding).toHaveBeenCalled();
  });
  it('does not fall back to a human cookie on an invalid bearer', async () => {
    verify.mockResolvedValue(null);
    expect(await gitAuthority(req())).toBe(401);
    expect(session).not.toHaveBeenCalled();
  });
  it.each([
    { isServiceToken: true }, { sub: '' }, { aud: 'https://unrelated.test' }, { scope: 'github:write' },
  ])('refuses invalid credential ceiling %#', async patch => {
    verify.mockResolvedValue({ ...payload(), ...patch });
    expect(await gitAuthority(req())).toBe(401);
    expect(introspect).not.toHaveBeenCalled();
  });
  it.each([
    { revokedAt: new Date() }, { expiresAt: new Date(0) }, { issuerDid: other },
    { subjectDid: other }, { type: 'unrelated' }, { payload: { scopes: ['github:write'] } },
  ])('refuses stale or mismatched app authorization %#', async patch => {
    rows([owner], { subtype: 'agent' }, { ...authorization(), ...patch });
    expect(await gitAuthority(req())).toBe(401);
    expect(introspect).not.toHaveBeenCalled();
  });
  it('refuses an agent x-acting-as header rather than treating it as the owner', async () => {
    expect(await gitAuthority(req({ 'x-acting-as': owner }))).toBe(401);
  });
  it.each([undefined, 'did:imajin:org'])('uses verified acting identity for direct human context %s', async actingAs => {
    session.mockResolvedValue({ identity: { id: owner, subtype: 'human', actingAs } });
    expect(await gitAuthority(req({}, false))).toEqual({ actorDid: owner, ownerDid: actingAs ?? owner });
    expect(session).toHaveBeenCalledWith(expect.any(Request), { service: 'github', allowMemberActAs: true });
    expect(introspect).not.toHaveBeenCalled();
  });
  it('never treats agent session delegation or a missing human subtype as a direct owner', async () => {
    session.mockResolvedValue({ identity: { id: agent, subtype: 'agent', actingFor: owner } });
    expect(await gitAuthority(req({}, false))).toBe(401);
  });
});
