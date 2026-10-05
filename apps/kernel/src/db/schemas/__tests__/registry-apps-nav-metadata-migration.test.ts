/**
 * Real-engine migration coverage for 0167 (#2425): registry.apps gains nav
 * metadata columns, backfilled for the 6 first-party apps #1981 will
 * eventually extract out of the monorepo.
 *
 * Runs the actual migration SQL against an embedded `@electric-sql/pglite`
 * Postgres instance (same technique as
 * `./registry-apps-redirect-uris-migration.test.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Heavy suite (embedded PGlite / seed replay / dynamic imports): the 5000ms
// default is too tight on contended CI runners (#2548). Scoped to this file;
// the global default is intentionally left unchanged.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function findRepoMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `registry-apps-nav-metadata-migration.test.ts: could not locate the repo's migrations/ directory by walking up from ${import.meta.url}`,
  );
}

const migrationsDir = findRepoMigrationsDir();
function readMigration(filename: string): string {
  return readFileSync(join(migrationsDir, filename), 'utf-8');
}

const SEED = readMigration('0001_seed.sql');
const REGISTRY_APPS = readMigration('0007_registry_apps.sql');
const REGISTRY_FIELDS = readMigration('0138_registry_apps_registry_fields.sql');
const REGISTRY_APPS_SLUG = readMigration('0163_registry_apps_slug.sql');
const SEED_FIRST_PARTY = readMigration('0139_registry_apps_seed_first_party.sql');
const NAV_METADATA = readMigration('0167_registry_apps_nav_metadata.sql');

let client: PGlite;

afterEach(async () => {
  await client?.close();
});

interface NavRow {
  slug: string | null;
  icon: string | null;
  entry_url: string | null;
  placements: string[];
  required_scope: string | null;
}

describe('0167_registry_apps_nav_metadata (#2425)', () => {
  it('adds nav columns and backfills the 6 extractable first-party apps, leaving jin untouched', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await client.exec(REGISTRY_APPS);
    await client.exec(REGISTRY_FIELDS);
    await client.exec(SEED_FIRST_PARTY);
    await client.exec(REGISTRY_APPS_SLUG);

    await client.exec(NAV_METADATA);

    const { rows } = await client.query<NavRow>(
      'SELECT slug, icon, entry_url, placements, required_scope FROM registry.apps ORDER BY slug',
    );
    const bySlug = new Map(rows.map((r) => [r.slug, r]));

    // #2425 send-back: required_scope must be NULL for every first-party app
    // — services.ts's `visibility: 'creator'` is a display tier, not one of
    // the four identity scopes (actor|business|community|family), so it must
    // never be written into this column (see this migration's own header).
    expect(bySlug.get('coffee')).toMatchObject({
      icon: '☕',
      entry_url: '/coffee',
      placements: ['launcher', 'home', 'auth-submenu'],
      required_scope: null,
    });
    expect(bySlug.get('dykil')).toMatchObject({ icon: '📋', entry_url: '/dykil', required_scope: null });
    expect(bySlug.get('links')).toMatchObject({ icon: '🔗', entry_url: '/links', required_scope: null });
    expect(bySlug.get('learn')).toMatchObject({ icon: '📚', entry_url: '/learn', required_scope: null });
    expect(bySlug.get('events')).toMatchObject({ icon: '🎫', entry_url: '/events', required_scope: null });
    expect(bySlug.get('market')).toMatchObject({ icon: '🏪', entry_url: '/market', required_scope: null });

    // jin (the neutral shell) is deliberately left with no placements by this migration.
    const jin = bySlug.get('jin');
    expect(jin?.placements).toEqual([]);
  });

  it('claims the dykil slug for the legacy first-party row so it stays nav-reachable (no third-party row exists yet)', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await client.exec(REGISTRY_APPS);
    await client.exec(REGISTRY_FIELDS);
    await client.exec(SEED_FIRST_PARTY);
    await client.exec(REGISTRY_APPS_SLUG);

    const preRows = await client.query<{ slug: string | null }>(
      `SELECT slug FROM registry.apps WHERE id = 'app_first_party_dykil'`,
    );
    expect(preRows.rows[0]?.slug).toBeNull();

    await client.exec(NAV_METADATA);

    const { rows } = await client.query<{ slug: string | null }>(
      `SELECT slug FROM registry.apps WHERE id = 'app_first_party_dykil'`,
    );
    expect(rows[0]?.slug).toBe('dykil');
  });

  it('does not touch dykil slug when a third-party row has already claimed it (post-extraction)', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await client.exec(REGISTRY_APPS);
    await client.exec(REGISTRY_FIELDS);
    await client.exec(SEED_FIRST_PARTY);
    await client.exec(REGISTRY_APPS_SLUG);
    await client.query(
      `INSERT INTO registry.apps (id, owner_did, name, app_did, public_key, callback_url, tier, slug)
       VALUES ('app_extracted_dykil', 'did:imajin:platform', 'Dykil', 'did:imajin:app-extracted-dykil', 'pk', 'https://dykil.example/callback', 'third_party', 'dykil')`,
    );

    await expect(client.exec(NAV_METADATA)).resolves.not.toThrow();

    const legacy = await client.query<{ slug: string | null }>(
      `SELECT slug FROM registry.apps WHERE id = 'app_first_party_dykil'`,
    );
    expect(legacy.rows[0]?.slug).toBeNull();
  });

  it('is idempotent on re-run and never clobbers a manually-set row', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await client.exec(REGISTRY_APPS);
    await client.exec(REGISTRY_FIELDS);
    await client.exec(SEED_FIRST_PARTY);
    await client.exec(REGISTRY_APPS_SLUG);
    await client.exec(NAV_METADATA);

    // Simulate an operator hand-editing coffee's icon via the admin surface.
    await client.query(`UPDATE registry.apps SET icon = '🫖' WHERE slug = 'coffee'`);

    await expect(client.exec(NAV_METADATA)).resolves.not.toThrow();

    const { rows } = await client.query<{ icon: string | null }>(
      `SELECT icon FROM registry.apps WHERE slug = 'coffee'`,
    );
    expect(rows[0]?.icon).toBe('🫖');
  });

  it('adds every new column as nullable/defaulted so pre-existing third-party rows are unaffected', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await client.exec(REGISTRY_APPS);
    await client.exec(REGISTRY_FIELDS);
    await client.exec(REGISTRY_APPS_SLUG);
    await client.query(
      `INSERT INTO registry.apps (id, owner_did, name, app_did, public_key, callback_url)
       VALUES ('app_third_party', 'did:imajin:owner', 'Third Party App', 'did:imajin:app_third_party', 'pk', 'https://example.com/callback')`,
    );

    await expect(client.exec(NAV_METADATA)).resolves.not.toThrow();

    const { rows } = await client.query<NavRow>(
      `SELECT slug, icon, entry_url, placements, required_scope FROM registry.apps WHERE id = 'app_third_party'`,
    );
    expect(rows[0]).toMatchObject({ icon: null, entry_url: null, placements: [], required_scope: null });
  });
});
