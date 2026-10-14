/**
 * Execute the 0185/0188-style retirement against real embedded Postgres.
 * #2808 additionally requires a hand-cleared legacy slug to remain untouched.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function readMigration(filename: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../../../migrations/${filename}`, import.meta.url)),
    'utf-8',
  );
}

const retirement = readMigration('0190_retire_legacy_events_registry_row.sql');
let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec('CREATE SCHEMA registry;');
  for (const filename of [
    '0007_registry_apps.sql',
    '0138_registry_apps_registry_fields.sql',
    '0139_registry_apps_seed_first_party.sql',
    '0163_registry_apps_slug.sql',
    '0167_registry_apps_nav_metadata.sql',
  ]) {
    await client.exec(readMigration(filename));
  }
});

afterEach(async () => {
  await client?.close();
});

async function registryRows() {
  return (await client.query('SELECT * FROM registry.apps ORDER BY id')).rows;
}

async function provisionReplacement(status = 'active', audience = 'events') {
  // The unique events slug still belongs to the legacy row until retirement.
  await client.query(
    `INSERT INTO registry.apps (
       id, owner_did, name, app_did, public_key, callback_url, status, token_audiences
     ) VALUES (
       'app_standalone_events', 'did:imajin:platform', 'Events',
       'did:imajin:standalone-events', 'non-functional-placeholder',
       'https://events.example/callback', $1, ARRAY[$2]::text[]
     )`,
    [status, audience],
  );
}

describe('0190_retire_legacy_events_registry_row (#2808)', () => {
  it('retires only the legacy row when another active row answers events, without touching events data', async () => {
    await provisionReplacement();
    await client.exec(`
      CREATE SCHEMA events;
      CREATE TABLE events.retirement_sentinel (id text PRIMARY KEY, title text);
      INSERT INTO events.retirement_sentinel VALUES ('event_existing', 'Keep this event');
    `);
    const before = await registryRows();
    const eventData = await client.query('SELECT * FROM events.retirement_sentinel');

    await client.exec(retirement);

    const after = await registryRows();
    const legacy = after.find((row) => row.id === 'app_first_party_events');
    expect(legacy).toMatchObject({
      status: 'revoked',
      token_audiences: [],
      slug: null,
      placements: [],
    });
    expect(legacy?.revoked_at).toBeInstanceOf(Date);
    expect(after.filter((row) => row.id !== 'app_first_party_events')).toEqual(
      before.filter((row) => row.id !== 'app_first_party_events'),
    );
    expect((await client.query('SELECT * FROM events.retirement_sentinel')).rows).toEqual(eventData.rows);
    const active = await client.query(
      `SELECT id FROM registry.apps WHERE status = 'active' AND 'events' = ANY (token_audiences)`,
    );
    expect(active.rows).toEqual([{ id: 'app_standalone_events' }]);
  });

  it('leaves every row untouched when only the legacy row answers events', async () => {
    const before = await registryRows();
    await client.exec(retirement);
    expect(await registryRows()).toEqual(before);
  });

  it.each([
    ['revoked', 'events'],
    ['active', 'coffee'],
  ])('does not retire for a replacement with status=%s and audience=%s', async (status, audience) => {
    await provisionReplacement(status, audience);
    const before = await registryRows();
    await client.exec(retirement);
    expect(await registryRows()).toEqual(before);
  });

  it('is a no-op on re-run, including both timestamps', async () => {
    await provisionReplacement();
    await client.exec(retirement);
    const before = await registryRows();
    await client.exec(retirement);
    expect(await registryRows()).toEqual(before);
  });

  it('is a no-op when the slug was already cleared by hand, even with an active replacement', async () => {
    await client.exec(`UPDATE registry.apps SET slug = NULL WHERE id = 'app_first_party_events'`);
    await provisionReplacement();
    await client.exec(`UPDATE registry.apps SET slug = 'events' WHERE id = 'app_standalone_events'`);
    const before = await registryRows();
    await client.exec(retirement);
    expect(await registryRows()).toEqual(before);
  });

  it('preserves a pre-existing revoked_at value when retiring an active row', async () => {
    await provisionReplacement();
    await client.exec(`
      UPDATE registry.apps SET revoked_at = '2026-10-01T00:00:00Z'
      WHERE id = 'app_first_party_events'
    `);
    await client.exec(retirement);
    const rows = await registryRows();
    expect(rows.find((row) => row.id === 'app_first_party_events')).toMatchObject({
      status: 'revoked',
      revoked_at: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('leaves an already-revoked legacy row untouched', async () => {
    await provisionReplacement();
    await client.exec(`UPDATE registry.apps SET status = 'revoked' WHERE id = 'app_first_party_events'`);
    const before = await registryRows();
    await client.exec(retirement);
    expect(await registryRows()).toEqual(before);
  });
});
