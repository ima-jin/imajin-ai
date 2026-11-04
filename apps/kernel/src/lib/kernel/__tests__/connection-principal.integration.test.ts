import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'), get db() { return h.db; },
}));

import { delegationGrants, identities, identityMembers } from '@/src/db/schemas/auth';
import { resolveConnectionPrincipal } from '../connection-principal';

const AGENT = 'did:imajin:agent';
const HUMAN = 'did:imajin:human';
const ORG = 'did:imajin:org';
const caller = { actorDid: AGENT, actingAs: ORG };
let client: PGlite;
let database: ReturnType<typeof drizzle>;

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth');
  for (const table of [identities, identityMembers, delegationGrants]) {
    const config = getTableConfig(table);
    const columns = config.columns.map(column => `"${column.name}" ${column.getSQLType()}`);
    await client.exec(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`);
  }
  database = drizzle(client);
  h.db = database;
});
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await client.exec('TRUNCATE auth.identities, auth.identity_members, auth.delegation_grants');
  await database.insert(identities).values([
    { id: AGENT, publicKey: 'agent-public', scope: 'actor', subtype: 'agent' },
    { id: HUMAN, publicKey: 'human-public', scope: 'actor', subtype: 'human' },
    { id: ORG, publicKey: 'org-public', scope: 'business' },
  ]);
});
async function assign(allowedServices: string[] | null = null) {
  await database.insert(identityMembers).values({
    identityDid: ORG, memberDid: AGENT, role: 'agent', allowedServices,
  });
}
async function delegate() {
  await database.insert(delegationGrants).values({
    id: 'assignment', agentDid: AGENT, delegatorDid: ORG, audience: { type: 'dids', values: [ORG] },
    issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), status: 'active',
  });
}
it('resolves a live membership assignment without any delegation or member-key grant', async () => {
  await assign();
  expect(await resolveConnectionPrincipal(caller, 'infer')).toEqual({
    ownerDid: ORG, actorDid: AGENT, orgContext: { memberDid: AGENT, orgDid: ORG, assignedAgentDid: AGENT },
  });
});
it('allows the included service and refuses an explicit restriction even when a parallel delegation exists', async () => {
  await assign(['infer']);
  await delegate();
  expect(await resolveConnectionPrincipal(caller, 'infer')).toHaveProperty('ownerDid', ORG);
  await expect(resolveConnectionPrincipal(caller, 'warp')).rejects.toMatchObject({ status: 403 });
  await database.update(identityMembers).set({ allowedServices: [] });
  await expect(resolveConnectionPrincipal(caller, 'infer')).rejects.toMatchObject({ status: 403 });
});
it.each(['revoked', 'expired', 'wrong-delegator', 'wrong-agent', 'wrong-audience', 'malformed-audience'])(
  'refuses a delegation that is %s', async boundary => {
    await delegate();
    if (boundary === 'revoked') await database.update(delegationGrants).set({ revokedAt: new Date(), status: 'revoked' });
    if (boundary === 'expired') await database.update(delegationGrants).set({ expiresAt: new Date(0) });
    if (boundary === 'wrong-delegator') await database.update(delegationGrants).set({ delegatorDid: HUMAN });
    if (boundary === 'wrong-agent') await database.update(delegationGrants).set({ agentDid: HUMAN });
    if (boundary === 'wrong-audience') await database.update(delegationGrants).set({ audience: { type: 'dids', values: [HUMAN] } });
    if (boundary === 'malformed-audience') await database.update(delegationGrants).set({ audience: { type: 'dids', values: [] } });
    await expect(resolveConnectionPrincipal(caller, 'infer')).rejects.toMatchObject({ status: 403 });
  },
);
it.each([AGENT, ORG])('refuses a suspended identity %s before choosing a key', async did => {
  await assign();
  await database.update(identities).set({ suspendedAt: new Date() }).where(eq(identities.id, did));
  await expect(resolveConnectionPrincipal(caller, 'infer')).rejects.toMatchObject({ status: 403 });
});
it('refuses unknown target identities even if an assignment row exists', async () => {
  await database.insert(identityMembers).values({ identityDid: 'did:imajin:unknown', memberDid: AGENT, role: 'agent' });
  await expect(resolveConnectionPrincipal({ actorDid: AGENT, actingAs: 'did:imajin:unknown' }, 'infer'))
    .rejects.toMatchObject({ status: 403 });
});
it('does not treat a human role=agent row as permission to use the agent assignment lane', async () => {
  await database.insert(identityMembers).values({ identityDid: ORG, memberDid: HUMAN, role: 'agent' });
  expect(await resolveConnectionPrincipal({ actorDid: HUMAN, actingAs: ORG }, 'infer')).toEqual({
    ownerDid: ORG, actorDid: HUMAN, orgContext: { memberDid: HUMAN, orgDid: ORG },
  });
  await expect(resolveConnectionPrincipal({ actorDid: HUMAN, actingFor: ORG }, 'infer'))
    .rejects.toMatchObject({ status: 403 });
});
it('keeps a human agent on its human principal for the separate org-member grant lane', async () => {
  await database.insert(identityMembers).values({ identityDid: HUMAN, memberDid: AGENT, role: 'agent' });
  expect(await resolveConnectionPrincipal({ actorDid: AGENT, actingFor: HUMAN, actingAs: ORG }, 'infer')).toEqual({
    ownerDid: ORG, actorDid: AGENT, orgContext: { memberDid: HUMAN, orgDid: ORG },
  });
});
it('does not inherit any assigned DID when the caller acts as itself', async () => {
  await assign();
  expect(await resolveConnectionPrincipal({ actorDid: AGENT }, 'infer')).toEqual({ ownerDid: AGENT, actorDid: AGENT });
});

describe('presence actors use the same assignment boundary as agents', () => {
  beforeEach(async () => {
    await database.update(identities).set({ subtype: 'presence' }).where(eq(identities.id, AGENT));
  });

  it.each(['warp', 'infer'])('acts for a personal or org principal on %s without a key grant', async service => {
    await assign();
    await database.insert(identityMembers).values({ identityDid: HUMAN, memberDid: AGENT, role: 'agent' });
    expect(await resolveConnectionPrincipal({ actorDid: AGENT, actingFor: HUMAN }, service)).toEqual({
      ownerDid: HUMAN, actorDid: AGENT,
    });
    const orgPrincipal = {
      ownerDid: ORG, actorDid: AGENT,
      orgContext: { memberDid: AGENT, orgDid: ORG, assignedAgentDid: AGENT },
    };
    expect(await resolveConnectionPrincipal({ actorDid: AGENT, actingFor: ORG }, service)).toEqual(orgPrincipal);
    expect(await resolveConnectionPrincipal(caller, service)).toEqual(orgPrincipal);
    expect(await resolveConnectionPrincipal({ actorDid: AGENT, actingFor: HUMAN, actingAs: ORG }, service)).toEqual({
      ownerDid: ORG, actorDid: AGENT, orgContext: { memberDid: HUMAN, orgDid: ORG },
    });
    expect(await resolveConnectionPrincipal({ actorDid: AGENT }, service)).toEqual({
      ownerDid: AGENT, actorDid: AGENT,
    });
  });

  it('permits a valid delegation without a membership', async () => {
    await delegate();
    expect(await resolveConnectionPrincipal({ actorDid: AGENT, actingFor: ORG }, 'infer')).toMatchObject({
      ownerDid: ORG, actorDid: AGENT, orgContext: { assignedAgentDid: AGENT },
    });
  });

  it.each(['unassigned', 'removed', 'non-agent-role', 'expired', 'revoked'])(
    'refuses a presence that is %s', async boundary => {
      if (boundary === 'removed' || boundary === 'non-agent-role') {
        await assign();
        await database.update(identityMembers).set(
          boundary === 'removed' ? { removedAt: new Date() } : { role: 'member' },
        );
      }
      if (boundary === 'expired' || boundary === 'revoked') {
        await delegate();
        await database.update(delegationGrants).set(
          boundary === 'expired' ? { expiresAt: new Date(0) } : { revokedAt: new Date(), status: 'revoked' },
        );
      }
      for (const service of ['warp', 'infer']) {
        await expect(resolveConnectionPrincipal({ actorDid: AGENT, actingFor: ORG }, service))
          .rejects.toMatchObject({
            status: 403, code: 'agent_not_assigned', message: 'Agent is not assigned to this identity or service',
          });
        await expect(resolveConnectionPrincipal(caller, service)).rejects.toMatchObject({ status: 403 });
      }
    },
  );

  it.each(['warp', 'infer'])('keeps %s service restrictions ahead of a parallel grant', async service => {
    await assign([service]);
    await delegate();
    const actingFor = { actorDid: AGENT, actingFor: ORG };
    expect(await resolveConnectionPrincipal(actingFor, service)).toHaveProperty('ownerDid', ORG);
    await database.update(identityMembers).set({ allowedServices: [service === 'warp' ? 'infer' : 'warp'] });
    await expect(resolveConnectionPrincipal(actingFor, service))
      .rejects.toMatchObject({ status: 403, code: 'service_not_allowed' });
    await database.update(identityMembers).set({ allowedServices: [] });
    await expect(resolveConnectionPrincipal(actingFor, service))
      .rejects.toMatchObject({ status: 403, code: 'service_not_allowed' });
  });
});

it.each(['human', 'device', null])('does not allow subtype %s to act-for even with assignment and grant', async subtype => {
  await database.update(identities).set({ subtype }).where(eq(identities.id, AGENT));
  await assign();
  await delegate();
  for (const service of ['warp', 'infer']) {
    await expect(resolveConnectionPrincipal({ actorDid: AGENT, actingFor: ORG }, service))
      .rejects.toMatchObject({ status: 403, code: 'agent_not_assigned' });
  }
});
