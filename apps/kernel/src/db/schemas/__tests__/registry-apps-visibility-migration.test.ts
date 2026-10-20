import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.setConfig({ testTimeout: 30_000 });
const migration = readFileSync(new URL('../../../../../../migrations/archive/pre-kernel-baseline/0204_registry_apps_visibility.sql', import.meta.url), 'utf8');
let client: PGlite;
afterEach(async () => { await client?.close(); });

describe('registry app visibility migration', () => {
  it('preserves existing listings, backfills API-only apps and Artifact, and enforces four values', async () => {
    client = new PGlite();
    await client.exec(`
      CREATE SCHEMA registry;
      CREATE TABLE registry.apps (id text PRIMARY KEY, slug text, tier text);
      INSERT INTO registry.apps VALUES
        ('app_first_party_coffee', 'coffee', 'first_party'),
        ('extracted', 'learn', 'third_party'),
        ('custom', 'custom', 'third_party'),
        ('usage', 'usage', 'first_party'),
        ('calendar', 'calendar', 'first_party'),
        ('workspace', 'workspace', 'first_party'),
        ('artifact', 'artifact', 'third_party');
    `);
    await client.exec(migration);
    const { rows } = await client.query<{ slug: string; visibility: string }>(
      'SELECT slug, visibility FROM registry.apps ORDER BY slug',
    );
    expect(Object.fromEntries(rows.map((row) => [row.slug, row.visibility]))).toEqual({
      artifact: 'private', calendar: 'internal', coffee: 'public', custom: 'public',
      learn: 'public', usage: 'internal', workspace: 'internal',
    });
    await expect(client.exec("INSERT INTO registry.apps (id) VALUES ('new')")).resolves.toBeDefined();
    expect((await client.query<{ visibility: string }>("SELECT visibility FROM registry.apps WHERE id = 'new'")).rows[0].visibility).toBe('public');
    for (const value of ['public', 'unlisted', 'private', 'internal']) {
      await expect(client.query('UPDATE registry.apps SET visibility = $1 WHERE id = $2', [value, 'new'])).resolves.toBeDefined();
    }
    await expect(client.exec("UPDATE registry.apps SET visibility = 'creator'")).rejects.toThrow();
    await expect(client.exec('UPDATE registry.apps SET visibility = NULL')).rejects.toThrow();
  });
});
