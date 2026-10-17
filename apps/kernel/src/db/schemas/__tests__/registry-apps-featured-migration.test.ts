import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const migration = readFileSync(
  new URL('../../../../../../migrations/0203_registry_apps_featured.sql', import.meta.url), 'utf8',
);
let client: PGlite;
afterEach(async () => { await client?.close(); });

describe('0203 registry.apps.featured', () => {
  it('defaults old and new rows to false, rejects null, and reruns without clobbering curation', async () => {
    client = new PGlite();
    await client.exec(`
      CREATE SCHEMA registry;
      CREATE TABLE registry.apps (id text PRIMARY KEY);
      INSERT INTO registry.apps (id) VALUES ('existing');
    `);
    await client.exec(migration);
    await client.exec("INSERT INTO registry.apps (id) VALUES ('new')");
    const initial = await client.query('SELECT featured FROM registry.apps ORDER BY id');
    expect(initial.rows).toEqual([{ featured: false }, { featured: false }]);
    await expect(client.exec("UPDATE registry.apps SET featured = NULL WHERE id = 'existing'")).rejects.toThrow();
    await client.exec("UPDATE registry.apps SET featured = true WHERE id = 'existing'");
    await client.exec(migration);
    const curated = await client.query("SELECT featured FROM registry.apps WHERE id = 'existing'");
    expect(curated.rows).toEqual([{ featured: true }]);
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'registry'");
    expect(tables.rows).toEqual([{ tablename: 'apps' }]);
  });
});
