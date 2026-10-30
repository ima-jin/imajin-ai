import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { generateKeypair, sign } from '../browser-keys';
import { didFromPublicKey } from '../crypto';
import * as schema from '@/src/db/schemas/auth';

const h = vi.hoisted(() => ({
  database: undefined as PgliteDatabase | undefined,
  authorized: true, failSigning: false,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  db: {
    transaction: (fn: Parameters<PgliteDatabase['transaction']>[0]) => h.database!.transaction(fn),
  },
}));
vi.mock('@/src/lib/vault/import-authority', () => ({
  controlsImportOwner: vi.fn(async () => h.authorized),
}));
vi.mock('../emit-mechanical-attestation', () => ({
  prepareMechanicalAttestation: vi.fn(async (params: Record<string, unknown>) => {
    if (h.failSigning) throw new Error('Signing unavailable');
    return { ...params, id: crypto.randomUUID(), issuerDid: 'did:imajin:node', signature: 'test-witness', issuedAt: new Date() };
  }),
}));

import { adoptAgent, prepareAdoption } from '../agent-adoption';
import { controlsImportOwner } from '@/src/lib/vault/import-authority';

function createTable(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let definition = `"${column.name}" ${column.getSQLType()}`;
    if (column.primary) definition += ' PRIMARY KEY';
    if (column.notNull) definition += ' NOT NULL';
    if (column.default !== undefined) {
      const value = column.default;
      const literal = value instanceof SQL ? new PgDialect().sqlToQuery(value).sql
        : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
      definition += ` DEFAULT ${literal}`;
    }
    return definition;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')})`;
}

let client: PGlite;
let intent: { actorDid: string; orgDid: string; agentDid: string; capabilities: string[] };
let keys: Awaited<ReturnType<typeof generateKeypair>>;
const database = () => h.database!;
beforeAll(async () => {
  client = new PGlite();
  h.database = drizzle(client);
  await client.exec('CREATE SCHEMA auth');
  for (const table of [schema.identities, schema.identityMembers, schema.agentProvisions, schema.challenges,
    schema.delegationGrants, schema.delegationGrantCapabilities, schema.delegationGrantEvents, schema.attestations]) {
    await client.exec(createTable(table));
  }
}, 20000);
afterAll(async () => { await client?.close(); });
beforeEach(async () => {
  h.authorized = true;
  h.failSigning = false;
  keys = await generateKeypair();
  intent = { actorDid: 'did:imajin:human', orgDid: `did:imajin:org-${crypto.randomUUID()}`,
    agentDid: didFromPublicKey(keys.publicKey), capabilities: ['messages:write'] };
  await database().insert(schema.identities).values([
    { id: intent.orgDid, scope: 'business', publicKey: crypto.randomUUID() },
    { id: intent.agentDid, scope: 'actor', subtype: 'agent', publicKey: keys.publicKey, handle: crypto.randomUUID() },
  ]);
});

async function signedProof() {
  const proof = await prepareAdoption(intent);
  return { ...proof, signature: await sign(proof.challenge, keys.privateKey) };
}
async function adopt(proof: Awaited<ReturnType<typeof signedProof>>) {
  return adoptAgent({ ...intent, challengeId: proof.challengeId, signature: proof.signature });
}
async function grantRows() {
  return database().select().from(schema.delegationGrants).where(eq(schema.delegationGrants.agentDid, intent.agentDid));
}

describe('orphan adoption (#3193)', () => {
  it('adopts with original key proof, unchanged DID/key, no membership and grant/attestation in one commit', async () => {
    const before = await database().select().from(schema.identities).where(eq(schema.identities.id, intent.agentDid));
    const proof = await signedProof();
    const result = await adopt(proof);
    expect(result).toMatchObject({ did: intent.agentDid, publicKey: keys.publicKey, grant: { delegatorDid: intent.orgDid } });
    expect(await database().select().from(schema.identities).where(eq(schema.identities.id, intent.agentDid))).toEqual(before);
    expect(await database().select().from(schema.identityMembers).where(eq(schema.identityMembers.identityDid, intent.agentDid))).toEqual([]);
    expect(await grantRows()).toHaveLength(1);
    expect(controlsImportOwner).toHaveBeenCalledWith(intent.actorDid, intent.orgDid, expect.anything(), 'auth');
    const events = await database().select().from(schema.delegationGrantEvents).where(eq(schema.delegationGrantEvents.grantId, result.grant.grantId));
    expect(events).toEqual([expect.objectContaining({ actorDid: intent.actorDid, event: 'issued' })]);
    const attestations = await database().select().from(schema.attestations).where(eq(schema.attestations.contextId, result.grant.grantId));
    expect(attestations.map(row => row.type).sort()).toEqual(['agent.adopted', 'delegation.grant.issued']);
    expect(JSON.parse(proof.challenge)).toMatchObject({ purpose: 'agent.adopt:v1', orgDid: intent.orgDid, actorDid: intent.actorDid, capabilities: intent.capabilities });
    const [challenge] = await database().select().from(schema.challenges).where(eq(schema.challenges.id, proof.challengeId));
    expect(challenge.usedAt).toBeInstanceOf(Date);
    expect(challenge.identityId).toBeNull();
  });

  it('rejects personal context and non-admin org authorization', async () => {
    await expect(prepareAdoption({ ...intent, orgDid: intent.agentDid })).rejects.toMatchObject({ status: 403 });
    h.authorized = false;
    await expect(prepareAdoption(intent)).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks admin authority at redemption', async () => {
    const proof = await signedProof();
    h.authorized = false;
    await expect(adopt(proof)).rejects.toMatchObject({ status: 403 });
    expect(await grantRows()).toEqual([]);
  });

  it.each(['human', 'device'])('rejects non-agent subtype %s', async subtype => {
    await database().update(schema.identities).set({ subtype }).where(eq(schema.identities.id, intent.agentDid));
    await expect(prepareAdoption(intent)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects missing and suspended agents', async () => {
    await expect(prepareAdoption({ ...intent, agentDid: 'did:imajin:missing' })).rejects.toMatchObject({ status: 409 });
    await database().update(schema.identities).set({ suspendedAt: new Date() }).where(eq(schema.identities.id, intent.agentDid));
    await expect(prepareAdoption(intent)).rejects.toMatchObject({ status: 409 });
  });

  it.each(['owner', 'reverse', 'removed', 'grant', 'provision'])('rejects non-orphan %s, including changes after challenge', async kind => {
    const proof = await signedProof();
    if (['owner', 'reverse', 'removed'].includes(kind)) {
      await database().insert(schema.identityMembers).values({
        identityDid: kind === 'reverse' ? intent.orgDid : intent.agentDid,
        memberDid: kind === 'reverse' ? intent.agentDid : intent.actorDid,
        role: 'owner', addedBy: intent.actorDid, removedAt: kind === 'removed' ? new Date() : null,
      });
    } else if (kind === 'grant') {
      await database().insert(schema.delegationGrants).values({
        id: crypto.randomUUID(), agentDid: intent.agentDid, delegatorDid: intent.orgDid,
        audience: { type: 'all' }, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60000), status: 'active',
      });
    } else {
      await database().insert(schema.agentProvisions).values({ id: crypto.randomUUID(), servingDid: intent.orgDid,
        delegatorDid: intent.orgDid, agentDid: intent.agentDid, handle: 'old-agent', harness: 'nanoclaw', placement: 'local' });
    }
    await expect(adopt(proof)).rejects.toMatchObject({ status: 409 });
  });

  it.each(['missing', 'expired', 'used', 'wrong-org', 'wrong-actor', 'wrong-purpose', 'wrong-key', 'malformed'])('refuses %s proof', async kind => {
    const proof = await signedProof();
    if (kind === 'missing') proof.challengeId = 'adopt_missing';
    if (kind === 'expired') await database().update(schema.challenges).set({ expiresAt: new Date(0) }).where(eq(schema.challenges.id, proof.challengeId));
    if (kind === 'used') await database().update(schema.challenges).set({ usedAt: new Date() }).where(eq(schema.challenges.id, proof.challengeId));
    if (['wrong-org', 'wrong-actor', 'wrong-purpose'].includes(kind)) {
      const payload = JSON.parse(proof.challenge);
      payload[kind === 'wrong-org' ? 'orgDid' : kind === 'wrong-actor' ? 'actorDid' : 'purpose'] = 'different';
      await database().update(schema.challenges).set({ challenge: JSON.stringify(payload) }).where(eq(schema.challenges.id, proof.challengeId));
    }
    if (kind === 'wrong-key') proof.signature = await sign(proof.challenge, (await generateKeypair()).privateKey);
    if (kind === 'malformed') proof.signature = '';
    await expect(adopt(proof)).rejects.toMatchObject({ status: 403 });
    expect(await grantRows()).toEqual([]);
  });

  it('consumes a challenge once and refuses a second adoption with a different challenge', async () => {
    const first = await signedProof();
    const second = await signedProof();
    await adopt(first);
    await expect(adopt(first)).rejects.toMatchObject({ status: 403 });
    await expect(adopt(second)).rejects.toMatchObject({ status: 409 });
    expect(await grantRows()).toHaveLength(1);
  });

  it('rolls back grant issuance and challenge consumption if signing fails', async () => {
    const proof = await signedProof();
    h.failSigning = true;
    await expect(adopt(proof)).rejects.toThrow('Signing unavailable');
    expect(await grantRows()).toEqual([]);
    const [challenge] = await database().select().from(schema.challenges).where(eq(schema.challenges.id, proof.challengeId));
    expect(challenge.usedAt).toBeNull();
    h.failSigning = false;
    await adopt(proof);
  });
});
