import { beforeEach, describe, expect, it, vi } from 'vitest';

const { results, queries, registration } = vi.hoisted(() => ({
  results: [] as unknown[][],
  queries: [] as { sql: string; params: unknown[] }[],
  registration: vi.fn(),
}));
vi.mock('@/src/db', async () => {
  const schema = await import('@/src/db/schemas/auth');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  function where(predicate: Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]) {
    queries.push(new PgDialect().sqlToQuery(predicate));
    const rows = results.shift() ?? [];
    return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
  }
  return {
    ...schema,
    db: {
      select: () => ({ from: () => ({ where }) }),
    },
  };
});
vi.mock('@imajin/auth', async () => import('../../../../../../packages/auth/src/delegation-grant'));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  readConnectorRegistration: registration,
  connectorRegistryId: (did: string, provider: string) => `card:${did}:${provider}`,
}));
import { loadInferenceRouteCandidates, readInferenceCard } from '../route-discovery-store';

const MEMBER = 'did:imajin:member';
const AGENT = 'did:imajin:agent';
const ORG = 'did:imajin:artifact';
const actor = (did = MEMBER, subtype = 'human') => ({ did, handle: did === MEMBER ? 'ryan' : 'jin', scope: 'actor', subtype });
const org = () => ({ did: ORG, handle: 'artifact', scope: 'business', subtype: null });
beforeEach(() => { results.length = 0; queries.length = 0; registration.mockReset(); });

describe('held-route enumeration (no credential authorization)', () => {
  it('enumerates personal own and C routes without granting membership any authority', async () => {
    results.push([actor()], [{ did: ORG, role: 'member' }], [org()]);
    const routes = await loadInferenceRouteCandidates({ ownerDid: MEMBER });
    expect(routes.map(row => [row.kind, row.principal.did])).toEqual([['own', MEMBER], ['C', ORG]]);
    expect(routes[1].context).toMatchObject({
      ownerDid: ORG, orgContext: { memberDid: MEMBER, orgDid: ORG },
      caller: { actorDid: MEMBER, actingAs: ORG },
    });
    expect(routes[1].principal.handle).toBe('artifact');
    expect(routes[1].orgHeld).toBe(true);
  });

  it('retains both the verified member and selected org identity, never the personal handle for org billing', async () => {
    results.push([actor()], [{ did: ORG, role: 'admin' }], [org()]);
    const context = { ownerDid: ORG, orgContext: { memberDid: MEMBER, orgDid: ORG } };
    const routes = await loadInferenceRouteCandidates(context);
    expect(routes).toHaveLength(2);
    expect(routes[1].context).toBe(context);
    expect(routes[1].principal).toEqual({ did: ORG, handle: 'artifact' });
    expect(routes[1].selectors).toEqual({ actingAs: ORG });
    expect(routes[0].context.ownerDid).toBe(MEMBER);
  });

  it('keeps A and B distinct and honors the verified caller interface without changing it', async () => {
    results.push(
      [actor(AGENT, 'agent')],
      [{ did: ORG, role: 'agent' }, { did: MEMBER, role: 'agent' }],
      [], [org()], [actor()],
    );
    const selected = { ownerDid: AGENT, caller: { actorDid: AGENT } };
    const routes = await loadInferenceRouteCandidates(selected);
    expect(routes.map(row => row.kind)).toEqual(['own', 'A', 'B']);
    expect(routes[1].context).toMatchObject({ caller: { actorDid: AGENT, actingAs: ORG } });
    expect(routes[2].context).toMatchObject({ caller: { actorDid: AGENT, actingFor: MEMBER } });
    expect(routes[1].pendingAssignmentResolver).toBeUndefined();
  });

  it('does not probe fabricated assignments on the older resolver', async () => {
    results.push([actor(AGENT, 'agent')], [{ did: ORG, role: 'agent' }], [], [org()]);
    const routes = await loadInferenceRouteCandidates({ ownerDid: AGENT });
    expect(routes[1].pendingAssignmentResolver).toBe(true);
  });

  it('does not enumerate unrelated principals, non-agent memberships, or app/registrant fallback identities', async () => {
    results.push([actor(AGENT, 'agent')], [{ did: ORG, role: 'member' }], []);
    const routes = await loadInferenceRouteCandidates({ ownerDid: AGENT, appDid: 'did:imajin:shared-app' });
    expect(routes.map(row => row.principal.did)).toEqual([AGENT]);
    expect(queries).toHaveLength(3);
    expect(queries[1].params).toEqual([AGENT]);
    expect(queries[1].sql).toContain('"member_did" = $1');
    expect(queries[1].sql).toContain('"removed_at" is null');
    expect(queries.flatMap(query => query.params)).not.toContain('did:imajin:shared-app');
  });

  it('only considers live delegation grants bound to this agent and an allowed audience', async () => {
    results.push([actor(AGENT, 'agent')], [], [
      { did: MEMBER, audience: { type: 'dids', values: [MEMBER] } },
      { did: ORG, audience: { type: 'dids', values: [MEMBER] } },
      { did: 'did:imajin:malformed', audience: { type: 'dids', values: [] } },
    ], [actor()]);
    const routes = await loadInferenceRouteCandidates({ ownerDid: AGENT, caller: { actorDid: AGENT } });
    expect(routes.map(row => row.principal.did)).toEqual([AGENT, MEMBER]);
    expect(queries[2].params[0]).toBe(AGENT);
    expect(queries[2].params[1]).toBe('active');
    expect(queries[2].sql).toContain('"revoked_at" is null');
    expect(queries[2].sql).toContain('"expires_at" >');
  });

  it('deduplicates a selected identity, membership and delegation for the same principal', async () => {
    results.push([actor(AGENT, 'agent')], [{ did: ORG, role: 'agent' }],
      [{ did: ORG, audience: { type: 'all' } }], [org()]);
    const routes = await loadInferenceRouteCandidates({
      ownerDid: ORG, caller: { actorDid: AGENT, actingAs: ORG },
      orgContext: { memberDid: AGENT, orgDid: ORG },
    });
    expect(routes.map(row => row.kind)).toEqual(['own', 'A']);
  });

  it('does not enumerate a human peer from an ordinary member relationship', async () => {
    results.push([actor()], [{ did: 'did:imajin:peer', role: 'member' }], [actor('did:imajin:peer')]);
    expect((await loadInferenceRouteCandidates({ ownerDid: MEMBER })).map(row => row.kind)).toEqual(['own']);
  });

  it('hides unavailable/suspended identities instead of traversing their relationships', async () => {
    results.push([]);
    expect(await loadInferenceRouteCandidates({ ownerDid: MEMBER })).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('"suspended_at" is null');
  });

  it('skips a disappeared related identity', async () => {
    results.push([actor()], [{ did: ORG, role: 'member' }], []);
    expect((await loadInferenceRouteCandidates({ ownerDid: MEMBER })).map(row => row.kind)).toEqual(['own']);
  });
});

describe('public card metadata', () => {
  it('returns only id, label and provider from the owning card', async () => {
    registration.mockResolvedValue({ id: 'card-org', label: 'Artifact Anthropic', sealedKeyField: 'private-reference', accountEmail: 'private' });
    expect(await readInferenceCard(ORG, 'anthropic', true)).toEqual({ id: 'card-org', label: 'Artifact Anthropic', provider: 'anthropic' });
    expect(registration).toHaveBeenCalledWith(ORG, 'org-held-anthropic', 'primary');
  });
  it('has a stable, nonsecret identity for a not-yet-loaded card', async () => {
    registration.mockResolvedValue(undefined);
    expect(await readInferenceCard(MEMBER, 'anthropic', false)).toEqual({
      id: `card:${MEMBER}:anthropic`, label: 'anthropic · primary', provider: 'anthropic',
    });
  });
});
