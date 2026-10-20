import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const migration = readFileSync(new URL('../../../../../../migrations/archive/pre-kernel-baseline/0206_registry_apps_template_lineage.sql', import.meta.url), 'utf8');
let client: PGlite;
afterEach(async () => { await client?.close(); });

describe('registry template lineage migration', () => {
  it('backfills active extracted identities, pending adopters and legacy nodes without hijacking unrelated slugs', async () => {
    client = new PGlite();
    await client.exec(`
      CREATE SCHEMA registry;
      CREATE SCHEMA kernel;
      CREATE TABLE registry.apps (id text PRIMARY KEY, app_did text, slug text, status text, tier text);
      CREATE TABLE kernel.app_provisions (slug text, app_did text, repo_url text);
    `);
    const joined = ['coffee', 'dykil', 'events', 'learn', 'links', 'market'];
    const pending = ['scorecard', 'karaoke', 'fixready'];
    for (const slug of [...joined, ...pending]) {
      await client.query("INSERT INTO registry.apps VALUES ($1, $2, $3, 'active', 'third_party')", [`app_${slug}`, `did:${slug}`, slug]);
      await client.query('INSERT INTO kernel.app_provisions VALUES ($1, $2, $3)', [slug, `did:${slug}`, `https://github.com/ima-jin/${slug}`]);
    }
    await client.exec(`
      INSERT INTO registry.apps VALUES
        ('app_first_party_coffee', 'did:old', NULL, 'revoked', 'first_party'),
        ('unrelated', 'did:unrelated', 'coffee', 'active', 'third_party'),
        ('app_first_party_dykil', 'did:legacy', NULL, 'active', 'first_party');
    `);
    await client.exec(migration);
    const result = await client.query('SELECT id, source_repo, template, template_ref, template_synced_at, joined FROM registry.apps WHERE template IS NOT NULL ORDER BY id');
    expect(result.rows).toEqual([...joined, ...pending].map((slug) => ({
      id: `app_${slug}`, source_repo: `ima-jin/${slug}`, template: 'ima-jin/imajin-app-template',
      template_ref: null, template_synced_at: null, joined: joined.includes(slug),
    })).concat([{
      id: 'app_first_party_dykil', source_repo: 'ima-jin/dykil', template: 'ima-jin/imajin-app-template',
      template_ref: null, template_synced_at: null, joined: false,
    }]).sort((a, b) => a.id.localeCompare(b.id)));
    const untouched = await client.query("SELECT source_repo, joined FROM registry.apps WHERE id IN ('unrelated', 'app_first_party_coffee')");
    expect(untouched.rows).toEqual([{ source_repo: null, joined: false }, { source_repo: null, joined: false }]);
    await client.exec(`INSERT INTO registry.apps (id) VALUES ('new');
      UPDATE registry.apps SET template_ref = 'v2', template_synced_at = now() WHERE id = 'app_coffee';`);
    await client.exec(migration);
    expect((await client.query("SELECT template_ref FROM registry.apps WHERE id = 'app_coffee'")).rows).toEqual([{ template_ref: 'v2' }]);
    expect((await client.query("SELECT joined FROM registry.apps WHERE id = 'new'")).rows).toEqual([{ joined: false }]);
    await expect(client.exec("UPDATE registry.apps SET joined = NULL WHERE id = 'new'")).rejects.toThrow();
  });
});
