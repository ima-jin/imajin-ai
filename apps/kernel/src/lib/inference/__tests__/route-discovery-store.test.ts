import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  results: [] as unknown[][], queries: [] as { sql: string; params: unknown[] }[],
  registration: vi.fn(), assignment: vi.fn(), principal: vi.fn(),
}));
vi.mock('@/src/db', async () => {
  const schema = await import('@/src/db/schemas/auth');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  function where(predicate: Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]) {
    h.queries.push(new PgDialect().sqlToQuery(predicate));
    const rows = h.results.shift() ?? [];
    return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
  }
  return { ...schema, db: { select: () => ({ from: () => ({ where }) }) } };
});
vi.mock('@/src/lib/kernel/connection-principal', () => ({
  requireAgentAssignment: h.assignment, resolveConnectionPrincipal: h.principal,
}));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  readConnectorRegistration: h.registration,
  connectorRegistryId: (did: string, provider: string) => `card:${did}:${provider}`,
}));
import { loadInferenceRouteCandidates, readInferenceCard } from '../route-discovery-store';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';

const MEMBER = 'did:imajin:member';
const AGENT = 'did:imajin:agent';
const ORG = 'did:imajin:artifact';
const actor = (did = MEMBER, subtype = 'human') => ({ did, handle: did === MEMBER ? 'ryan' : 'jin', scope: 'actor', subtype });
const org = () => ({ did: ORG, handle: 'artifact', scope: 'business', subtype: null });
beforeEach(() => {
  h.results.length = 0;
  h.queries.length = 0;
  vi.resetAllMocks();
  h.assignment.mockResolvedValue(undefined);
  h.principal.mockResolvedValue({});
});

describe('canonical held-route enumeration', () => {
  it('binds personal/organization metadata to their actual DIDs and checks every candidate', async () => {
    h.results.push([actor()], [{ did: ORG, role: 'member' }], [org()]);
    const routes = await loadInferenceRouteCandidates({ ownerDid: MEMBER });
    expect(routes.map(row => [row.kind, row.principal.did])).toEqual([['own', MEMBER], ['C', ORG]]);
    expect(routes[1].principal.handle).toBe('artifact');
    expect(routes[1].context).toMatchObject({
      ownerDid: ORG, caller: { actorDid: MEMBER, actingAs: ORG }, orgContext: { memberDid: MEMBER, orgDid: ORG },
    });
    expect(h.principal).toHaveBeenCalledWith({ actorDid: MEMBER, actingAs: ORG }, 'infer');
    expect(h.queries[1].params).toEqual([MEMBER]);
    expect(h.queries[1].sql).toContain('"removed_at" is null');
  });
  it('uses the canonical assignment gate, not an independent grant/audience interpretation', async () => {
    h.results.push([actor(AGENT, 'agent')], [], [{ did: ORG }, { did: MEMBER }], [org()]);
    h.assignment.mockImplementation(async (_db, _agent, did) => {
      if (did === MEMBER) throw new ExternalMcpError(403, 'arbitrary', 'agent_not_assigned');
    });
    const routes = await loadInferenceRouteCandidates({ ownerDid: AGENT, caller: { actorDid: AGENT } });
    expect(routes.map(row => row.principal.did)).toEqual([AGENT, ORG]);
    expect(h.assignment).toHaveBeenCalledWith(expect.anything(), AGENT, ORG, 'infer');
    expect(h.queries[2].sql).toContain('"revoked_at" is null');
    expect(h.queries[2].sql).toContain('"expires_at" >');
  });
  it('keeps an inference-excluded assignment visible with its typed denial and does not traverse a denied human', async () => {
    const error = new ExternalMcpError(403, 'arbitrary', 'service_not_allowed');
    h.results.push([actor(AGENT, 'agent')], [{ did: MEMBER, role: 'agent' }], [], [actor()]);
    h.assignment.mockRejectedValue(error);
    h.principal.mockImplementation(async caller => {
      if (caller.actingFor) throw error;
      return {};
    });
    const routes = await loadInferenceRouteCandidates({ ownerDid: AGENT });
    expect(routes[1]).toMatchObject({ kind: 'B', authorizationError: error });
    expect(h.queries).toHaveLength(4);
  });
  it('keeps direct org A and through-human C routes distinct', async () => {
    h.results.push([actor(AGENT, 'agent')], [{ did: ORG, role: 'agent' }, { did: MEMBER, role: 'agent' }],
      [], [org()], [actor()], [{ did: ORG, role: 'member' }], [org()]);
    const routes = await loadInferenceRouteCandidates({ ownerDid: AGENT });
    expect(routes.filter(row => row.principal.did === ORG).map(row => row.kind)).toEqual(['A', 'C']);
    expect(routes.at(-1)?.context.caller).toEqual({ actorDid: AGENT, actingFor: MEMBER, actingAs: ORG });
  });
  it('propagates unexpected assignment/store failures rather than silently exposing candidates', async () => {
    h.results.push([actor(AGENT, 'agent')], [{ did: ORG, role: 'agent' }], []);
    h.assignment.mockRejectedValue(new Error('database unavailable'));
    await expect(loadInferenceRouteCandidates({ ownerDid: AGENT })).rejects.toThrow('database unavailable');
  });
  it('propagates unexpected principal failures', async () => {
    h.results.push([actor()], []);
    h.principal.mockRejectedValue(new Error('database unavailable'));
    await expect(loadInferenceRouteCandidates({ ownerDid: MEMBER })).rejects.toThrow('database unavailable');
  });
  it('hides missing/suspended identities', async () => {
    h.results.push([]);
    expect(await loadInferenceRouteCandidates({ ownerDid: MEMBER })).toEqual([]);
    expect(h.queries[0].sql).toContain('"suspended_at" is null');
  });
  it('ignores an ordinary human peer relationship and disappeared targets', async () => {
    h.results.push([actor()], [{ did: 'did:imajin:peer', role: 'member' }, { did: ORG, role: 'member' }],
      [actor('did:imajin:peer')], []);
    expect((await loadInferenceRouteCandidates({ ownerDid: MEMBER })).map(row => row.kind)).toEqual(['own']);
  });
});

describe('public card metadata', () => {
  it('allowlists metadata and selects the org-held provider row', async () => {
    h.registration.mockResolvedValue({ id: 'card-org', label: 'Artifact Anthropic', sealedKeyField: 'private-reference' });
    expect(await readInferenceCard(ORG, 'anthropic', true)).toEqual({ id: 'card-org', label: 'Artifact Anthropic', provider: 'anthropic' });
    expect(h.registration).toHaveBeenCalledWith(ORG, 'org-held-anthropic', 'primary');
  });
  it('gives an unconfigured card a stable identity', async () => {
    expect(await readInferenceCard(MEMBER, 'anthropic', false)).toEqual({
      id: `card:${MEMBER}:anthropic`, label: 'anthropic · primary', provider: 'anthropic',
    });
  });
});
