import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync('migrations/0240_connectors_purpose_normalise.sql', 'utf8');
const dryRun = readFileSync('scripts/0240-connectors-purpose-dry-run.sql', 'utf8');
let client: PGlite;
let notices: string[];

beforeEach(async () => {
  notices = [];
  client = new PGlite();
  await client.exec(`
    CREATE SCHEMA kernel; CREATE SCHEMA auth; CREATE SCHEMA registry;
    CREATE TABLE auth.identities (id text PRIMARY KEY, scope text);
    CREATE TABLE registry.apps (app_did text, upstreams jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE kernel.connectors (
      id text PRIMARY KEY, owner_did text NOT NULL, provider text NOT NULL,
      slot text NOT NULL DEFAULT 'primary', upstream_binding text,
      loaded_by_did text, loaded_at timestamptz, sealed_key_field text,
      status text NOT NULL DEFAULT 'active'
    );
    CREATE UNIQUE INDEX uniq_connectors_owner_provider_slot
      ON kernel.connectors(owner_did, provider, slot);
    CREATE TABLE kernel.org_connection_suspensions (
      org_did text NOT NULL, member_did text NOT NULL DEFAULT '',
      provider text NOT NULL, slot text NOT NULL DEFAULT '', suspended_at timestamptz
    );
    CREATE UNIQUE INDEX uniq_org_connection_suspension
      ON kernel.org_connection_suspensions(org_did, member_did, provider, slot);
    CREATE TABLE kernel.org_connection_events (id text, payload jsonb);
    INSERT INTO auth.identities VALUES ('org', 'business'), ('agent', 'actor');
    INSERT INTO kernel.org_connection_events VALUES ('history', '{"keep":true}');
  `);
});
afterEach(async () => { await client.close(); });

async function migrate() {
  await client.transaction(async tx => {
    await tx.exec(migration, { onNotice: notice => notices.push(notice.message) });
  });
}
async function rows() {
  return (await client.query('SELECT * FROM kernel.connectors ORDER BY id')).rows;
}
async function report() {
  return (await client.query<Record<string, unknown>>(dryRun)).rows;
}

describe('0240 connector purpose normalization', () => {
  it('runs on a fresh database twice and keeps the dry-run SELECT-only with zero counts', async () => {
    expect(dryRun).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
    const before = await report();
    expect(before).toHaveLength(2);
    expect(before).toEqual(expect.arrayContaining([expect.objectContaining({
      source_table: 'org_connection_suspensions', collision_rows: 0, collision_keys: 0,
    })]));
    await migrate();
    await migrate();
    expect(await report()).toEqual(before);
    expect(await rows()).toEqual([]);
  });

  it('preserves ids, custody references, provenance and event history while separating both vendors billing purpose', async () => {
    await client.exec(`
      INSERT INTO kernel.connectors(id, owner_did, provider, sealed_key_field, loaded_by_did, loaded_at) VALUES
        ('inference', 'org', 'anthropic', 'reference-1', 'admin', '2026-11-01'),
        ('billing', 'org', 'anthropic-billing', 'reference-2', 'admin', '2026-11-01'),
        ('openai', 'org', 'org-held-openai-billing', 'reference-3', 'admin', '2026-11-01'),
        ('held', 'agent', 'org-held-warp', 'reference-4', 'admin', '2026-11-01');
    `);
    const before = await rows();
    const counts = await report();
    expect(counts[0]).toMatchObject({ prefix_rows: 2, suffix_rows: 2, collision_rows: 0 });
    await migrate();
    const after = await rows();
    expect(after).toEqual([
      expect.objectContaining({ id: 'billing', provider: 'anthropic', purpose: 'billing' }),
      expect.objectContaining({ id: 'held', owner_did: 'agent', provider: 'warp', purpose: 'inference' }),
      expect.objectContaining({ id: 'inference', provider: 'anthropic', purpose: 'inference' }),
      expect.objectContaining({ id: 'openai', provider: 'openai', purpose: 'billing' }),
    ]);
    for (const prior of before) {
      expect(after.find(row => row.id === prior.id)).toMatchObject({
        owner_did: prior.owner_did, sealed_key_field: prior.sealed_key_field,
        loaded_by_did: prior.loaded_by_did, loaded_at: prior.loaded_at,
      });
    }
    expect(notices.some(message => message.includes('legacy holder requires review'))).toBe(true);
    await migrate();
    expect(await rows()).toEqual(after);
    expect((await client.query('SELECT * FROM kernel.org_connection_events')).rows)
      .toEqual([{ id: 'history', payload: { keep: true } }]);
  });

  it('leaves every colliding connector untouched, reports ids and never deletes a row', async () => {
    await client.exec(`INSERT INTO kernel.connectors(id,owner_did,provider) VALUES
      ('canonical','org','warp'), ('legacy','org','org-held-warp');`);
    expect((await report())[0]).toMatchObject({ collision_rows: 2, collision_keys: 1 });
    const before = await rows();
    await migrate();
    expect(await rows()).toEqual(before.map(row => ({ ...row, purpose: 'inference' })));
    expect(notices.some(message => message.includes('id=legacy'))).toBe(true);
    await migrate();
    expect(await rows()).toHaveLength(2);
  });

  it('normalizes suspensions in place without changing active state or schema', async () => {
    await client.exec(`INSERT INTO kernel.org_connection_suspensions
      VALUES ('org','member','org-held-warp','primary','2026-11-01'),
        ('org','member','openai-billing','primary',NULL);`);
    await migrate();
    const result = (await client.query('SELECT * FROM kernel.org_connection_suspensions ORDER BY provider')).rows;
    expect(result).toEqual([
      { org_did: 'org', member_did: 'member', provider: 'openai', slot: 'primary', suspended_at: null },
      { org_did: 'org', member_did: 'member', provider: 'warp', slot: 'primary', suspended_at: expect.any(Date) },
    ]);
    await migrate();
    expect((await client.query('SELECT * FROM kernel.org_connection_suspensions ORDER BY provider')).rows).toEqual(result);
    expect((await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='kernel' AND table_name='org_connection_suspensions' ORDER BY ordinal_position`)).rows)
      .toHaveLength(5);
  });

  it('aborts and rolls back on any normalized suspension key collision, preserving an active suspension', async () => {
    await client.exec(`INSERT INTO kernel.org_connection_suspensions
      VALUES ('org','member','warp','primary',NULL),
        ('org','member','org-held-warp','primary','2026-11-01');
      INSERT INTO kernel.connectors(id,owner_did,provider) VALUES ('keep','org','org-held-anthropic');`);
    const before = await rows();
    expect((await report())[1]).toMatchObject({ collision_rows: 2, collision_keys: 1 });
    await expect(migrate()).rejects.toThrow(/suspension normalized-key collisions.*member.*warp/);
    expect(await rows()).toEqual(before);
    expect((await client.query('SELECT * FROM kernel.org_connection_suspensions')).rows).toHaveLength(2);
  });

  it('uses the declared host and existing binding slot, preserving the binding and leaving unknown/unbound rows untouched', async () => {
    await client.exec(`INSERT INTO registry.apps VALUES ('did:imajin:app',
      '[{"id":"catalog","origin":"https://api.example.test:8443"}]');
      INSERT INTO kernel.connectors(id,owner_did,provider,upstream_binding) VALUES
        ('bound','org','app-upstream:did:imajin:app:catalog','binding-hash'),
        ('unbound','agent','app-upstream:did:imajin:app:catalog',NULL),
        ('unknown','org','app-upstream:did:imajin:other:catalog','other-binding');`);
    expect((await report())[0]).toMatchObject({ upstream_rows: 3, unresolved_rows: 2 });
    await migrate();
    expect(await rows()).toEqual([
      expect.objectContaining({ id: 'bound', provider: 'api.example.test', upstream_binding: 'binding-hash', slot: 'binding-hash' }),
      expect.objectContaining({ id: 'unbound', provider: 'app-upstream:did:imajin:app:catalog', upstream_binding: null }),
      expect.objectContaining({ id: 'unknown', provider: 'app-upstream:did:imajin:other:catalog', upstream_binding: 'other-binding' }),
    ]);
    const after = await rows();
    await migrate();
    expect(await rows()).toEqual(after);
  });

  it('rejects invalid purposes and enforces uniqueness across owner, vendor, purpose and slot', async () => {
    await migrate();
    await client.exec(`INSERT INTO kernel.connectors(id,owner_did,provider,purpose) VALUES
      ('i','org','anthropic','inference'), ('b','org','anthropic','billing');`);
    await expect(client.exec(`INSERT INTO kernel.connectors(id,owner_did,provider,purpose)
      VALUES ('invalid','org','warp','upstream')`)).rejects.toThrow(/connectors_purpose_check/);
    await expect(client.exec(`INSERT INTO kernel.connectors(id,owner_did,provider,purpose)
      VALUES ('duplicate','org','anthropic','billing')`)).rejects.toThrow(/uniq_connectors_owner_provider_slot/);
  });
});
