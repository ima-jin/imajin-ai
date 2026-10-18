import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const migration = readFileSync(new URL('../../../../../../migrations/0205_registry_apps_profile_widget.sql', import.meta.url), 'utf8');
let client: PGlite;
afterEach(async () => { await client?.close(); });

describe('0205 registry profile widgets', () => {
  it('adds nullable declaration metadata, backfills legacy widgets, and never enables apps', async () => {
    client = new PGlite();
    await client.exec(`
      CREATE SCHEMA registry;
      CREATE TABLE registry.apps (slug text PRIMARY KEY);
      INSERT INTO registry.apps VALUES ('events'), ('market'), ('fixture-studio');
    `);
    await client.exec(migration);
    expect((await client.query("SELECT profile_widget FROM registry.apps WHERE slug = 'fixture-studio'")).rows).toEqual([{ profile_widget: null }]);
    expect((await client.query("SELECT profile_widget->>'label' AS label FROM registry.apps WHERE slug = 'events'")).rows).toEqual([{ label: 'Events' }]);
    expect((await client.query("SELECT profile_widget->>'label' AS label FROM registry.apps WHERE slug = 'market'")).rows).toEqual([{ label: 'Market' }]);
    await client.exec(`UPDATE registry.apps SET profile_widget = '{"path":"/custom","label":"Custom"}' WHERE slug = 'events'`);
    await client.exec(migration);
    expect((await client.query("SELECT profile_widget->>'path' AS path FROM registry.apps WHERE slug = 'events'")).rows).toEqual([{ path: '/custom' }]);
    expect((await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'registry'")).rows).toEqual([{ tablename: 'apps' }]);
    expect(migration).not.toMatch(/(?:UPDATE|INSERT INTO)\s+profile\.|enabled_apps|enabled_services|app\.authorized/i);
  });
});
