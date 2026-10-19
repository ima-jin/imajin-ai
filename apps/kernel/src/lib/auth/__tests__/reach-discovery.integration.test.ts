import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as auth from '@/src/db/schemas/auth';
import * as consent from '@/src/db/schemas/consent';
import { defaultFrontDoorConfig } from '@/src/lib/jin/front-door';
import { resolveReachDiscovery } from '../reach-discovery';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/consent'),
  get db() { return state.db; },
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@/src/lib/http/node-url', () => ({ nodeUrl: () => 'https://node.test' }));

const pg = new PGlite();
const database = drizzle(pg, { schema: { ...auth, ...consent } });
const did = 'did:imajin:ryan';
const gate = () => {
  const config = defaultFrontDoorConfig();
  config.tiers.soft = true;
  config.topics.collaboration = { open: true, published: true, mode: 'deliver' };
  config.topics.speaking = { open: true, published: false, mode: 'deliver' };
  return config;
};

beforeAll(async () => {
  state.db = database;
  await pg.exec(`CREATE SCHEMA auth; CREATE SCHEMA kernel;
    CREATE TABLE auth.identities (
      id text PRIMARY KEY, handle text, name text, metadata jsonb,
      scope text, subtype text, suspended_at timestamptz
    );
    CREATE TABLE kernel.consent_grants (
      id text PRIMARY KEY, subject text, purpose text, status text, granted_to_class text
    );`);
});
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('TRUNCATE auth.identities, kernel.consent_grants');
  await pg.query(`INSERT INTO auth.identities VALUES ($1, 'ryan', 'Ryan', $2, 'actor', 'human', NULL)`,
    [did, JSON.stringify({ agentReachGate: gate(), agentReachTopics: ['collaboration', 'speaking'], privateRule: 'PRIVATE' })]);
});

async function metadata(value: unknown) {
  await pg.query('UPDATE auth.identities SET metadata = $1 WHERE id = $2', [JSON.stringify(value), did]);
}

async function legacyGrant() {
  await pg.exec(`INSERT INTO kernel.consent_grants VALUES ('grant1', '${did}', 'agent.reach', 'active', 'strangers')`);
}

describe('public reach eligibility against real front-door state', () => {
  it.each([did, 'ryan', '@ryan'])('resolves %s and projects only published labels', async (id) => {
    const card = await resolveReachDiscovery(id);
    expect(card?.principalDid).toBe(did);
    expect(card?.reach.topics).toEqual(['Collaboration']);
    expect(JSON.stringify(card)).not.toMatch(/speaking|Speaking|PRIVATE|privateRule|dailyCap|agentReachGate/);
  });

  it('immediately hides discovery after an authored gate is turned off, even with a legacy grant', async () => {
    expect(await resolveReachDiscovery('@ryan')).not.toBeNull();
    await legacyGrant();
    await metadata({ agentReachGate: defaultFrontDoorConfig() });
    expect(await resolveReachDiscovery('@ryan')).toBeNull();
  });

  it.each([null, {}, { tiers: 'invalid' }, { tiers: { anonymous: true }, topics: {}, dailyCap: 25 }])(
    'fails closed on malformed authored gate %j regardless of legacy consent',
    async (value) => {
      await legacyGrant();
      await metadata({ agentReachGate: value, agentReachTopics: ['collaboration'] });
      expect(await resolveReachDiscovery(did)).toBeNull();
    },
  );

  it('preserves legacy grant-based discovery without publishing legacy topic values', async () => {
    await metadata({ agentReachTopics: ['collaboration'] });
    expect(await resolveReachDiscovery(did)).toBeNull();
    await legacyGrant();
    expect(await resolveReachDiscovery(did)).toMatchObject({ principalDid: did });
    expect((await resolveReachDiscovery(did))?.reach.topics).toBeUndefined();
    await pg.exec("UPDATE kernel.consent_grants SET status = 'revoked'");
    expect(await resolveReachDiscovery(did)).toBeNull();
  });
});
