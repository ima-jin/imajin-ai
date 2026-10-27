import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { canonicalize, crypto } from '@imajin/auth';

vi.setConfig({ hookTimeout: 30_000 });
const h = vi.hoisted(() => ({ db: null as unknown, destroy: vi.fn(), nodeDid: 'did:imajin:test-node' }));
vi.mock('@/src/db', async () => {
  const { connectors } = await import('@/src/db/schemas/connectors');
  const { attestations, channelLinks } = await import('@/src/db/schemas/auth');
  const { forwardingDb } = await import('@/src/lib/notify/__tests__/pglite-connector-inbox-harness');
  return { db: forwardingDb(() => h.db), connectors, attestations, channelLinks };
});
vi.mock('@/src/lib/vault/delete-secret', () => ({ deleteSecretAndRevokeGrants: h.destroy }));
vi.mock('../node-identity', () => ({ getNodeDid: async () => h.nodeDid }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));

import { removeConnectorConnection } from '../connector-removal';
import { assertConnectionNotRemoved } from '../connector-connection-status';
import { recordConnectorRegistration, revokeConnectorRegistration, syncConnectorRegistrationScopes, renameConnectorConnection, createConnectorConnection } from '../connector-registry-store';
import { connectors } from '@/src/db/schemas/connectors';
import { attestations, channelLinks } from '@/src/db/schemas/auth';

const keys = crypto.generateKeypair();
const owner = 'did:imajin:owner';
let client: PGlite;
let database: ReturnType<typeof drizzle>;

function createTable(table: PgTable) {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let defaultSql = '';
    if (['created_at', 'updated_at', 'issued_at'].includes(column.name)) defaultSql = ' DEFAULT now()';
    else if (typeof column.default === 'string') defaultSql = ` DEFAULT '${column.default}'`;
    else if (column.name === 'scopes') defaultSql = " DEFAULT '[]'::jsonb";
    return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel;');
  for (const table of [connectors, channelLinks, attestations]) await client.exec(createTable(table));
  await client.exec('CREATE UNIQUE INDEX uniq_connector ON kernel.connectors(owner_did,provider,slot);');
  database = drizzle(client);
  h.db = database;
});
afterAll(async () => client.close());
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  h.destroy.mockReset().mockResolvedValue(undefined);
  // Test fixtures are reset without deleting application history.
  await client.exec('TRUNCATE kernel.connectors, auth.channel_links, auth.attestations;');
});

async function seed(provider = 'github', did = owner, slot = 'work') {
  await database.insert(connectors).values({
    id: `${did}-${provider}-${slot}`, ownerDid: did, provider, slot, label: 'Company',
    channel: provider, connectorDid: `did:imajin:${provider}-connector`, status: 'active',
  });
  await database.insert(channelLinks).values({
    id: `${did}-${provider}-${slot}`, did, channel: provider, channelUid: `${did}-${slot}`,
    appDid: `did:imajin:${provider}-connector`, slot, scopes: [`${provider}:read`], status: 'active',
  });
}

describe('per-slot attested removal', () => {
  it.each(['github', 'google', 'quickbooks'])('destroys %s credentials via the vault API and hides history without deleting rows', async provider => {
    await seed(provider);
    await seed(provider, owner, 'primary');
    await seed(provider, 'did:imajin:other');
    await database.insert(channelLinks).values({
      id: 'consumer', did: owner, channel: provider, channelUid: 'consumer', appDid: 'did:imajin:consumer',
      slot: 'work', scopes: [`${provider}:read`], status: 'active',
    });
    const prefixes = [`${provider}-config`, `${provider}-oauth`, ...(provider === 'github' ? ['github-pat'] : [])];
    expect(await removeConnectorConnection(owner, provider, 'work', prefixes)).toEqual({ removed: true, slot: 'work' });
    expect(h.destroy.mock.calls.map(([field]) => field)).toEqual(prefixes.map(prefix => `${prefix}:${owner}:work`));
    const rows = await database.select().from(connectors);
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.ownerDid === owner && row.slot === 'work')?.status).toBe('removed');
    expect(rows.filter(row => row.status === 'active')).toHaveLength(2);
    const grants = await database.select().from(channelLinks);
    expect(grants.filter(row => row.did === owner && row.slot === 'work').every(row => row.status === 'revoked')).toBe(true);
    expect(grants.filter(row => row.status === 'active')).toHaveLength(2);
    const [audit] = await database.select().from(attestations);
    expect(audit).toMatchObject({ subjectDid: owner, type: 'connector.disconnected', payload: { ownerDid: owner, connector: provider, slot: 'work', action: 'removed' } });
    const canonical = canonicalize({
      subject_did: owner, type: audit.type, context_id: audit.contextId, context_type: audit.contextType,
      payload: audit.payload, issued_at: audit.issuedAt.getTime(),
    });
    expect(crypto.verifySync(audit.signature, canonical, keys.publicKey)).toBe(true);
    await expect(assertConnectionNotRemoved(owner, provider, 'work')).rejects.toThrow('Connection removed');
    await expect(assertConnectionNotRemoved(owner, provider, 'primary')).resolves.toBeUndefined();
    await expect(assertConnectionNotRemoved('did:imajin:other', provider, 'work')).resolves.toBeUndefined();
    await removeConnectorConnection(owner, provider, 'work', prefixes);
    expect(await database.select().from(attestations)).toHaveLength(1);
    expect(h.destroy).toHaveBeenCalledTimes(prefixes.length);
  });

  it('rejects cross-DID removal without destroying vault fields or changing the owned row', async () => {
    await seed();
    await expect(removeConnectorConnection('did:imajin:attacker', 'github', 'work', ['github-oauth'])).rejects.toMatchObject({ status: 404 });
    expect(h.destroy).not.toHaveBeenCalled();
    expect((await database.select().from(connectors))[0].status).toBe('active');
    expect(await database.select().from(attestations)).toHaveLength(0);
  });

  it.each(['primary', '../primary'])('blocks primary or invalid selector %s before any destruction', async slot => {
    await expect(removeConnectorConnection(owner, 'github', slot, ['github-oauth'])).rejects.toThrow();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('does not claim success when custody destruction fails; retry completes the attested change', async () => {
    await seed();
    h.destroy.mockRejectedValueOnce(new Error('vault unavailable'));
    await expect(removeConnectorConnection(owner, 'github', 'work', ['github-oauth'])).rejects.toThrow('vault unavailable');
    expect((await database.select().from(connectors))[0].status).toBe('active');
    expect(await database.select().from(attestations)).toHaveLength(0);
    await removeConnectorConnection(owner, 'github', 'work', ['github-oauth']);
    expect((await database.select().from(connectors))[0].status).toBe('removed');
  });

  it('does not destroy custody without a signing identity', async () => {
    await seed();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(removeConnectorConnection(owner, 'github', 'work', ['github-oauth'])).rejects.toThrow();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('cannot resurrect or rename a removed slot via old connect, scope-sync or disconnect writes', async () => {
    await seed();
    await removeConnectorConnection(owner, 'github', 'work', ['github-oauth']);
    await recordConnectorRegistration({ ownerDid: owner, provider: 'github', slot: 'work' });
    await syncConnectorRegistrationScopes(owner, 'github', ['github:read'], 'work');
    await revokeConnectorRegistration(owner, 'github', 'work');
    expect(await renameConnectorConnection(owner, 'github', 'work', 'Renamed')).toBeUndefined();
    await expect(createConnectorConnection(owner, 'github', 'work', 'Reused')).rejects.toThrow('connection_exists');
    const [row] = await database.select().from(connectors).where(eq(connectors.slot, 'work'));
    expect(row.status).toBe('removed');
    expect(row.label).toBe('Company');
    expect(row.scopes).toEqual([]);
  });
});
