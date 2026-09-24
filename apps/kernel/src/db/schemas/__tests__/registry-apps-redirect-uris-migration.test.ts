/**
 * Real-engine migration coverage for 0158 (#1348): registry.apps.redirect_uris
 * backfilled from callback_url.
 *
 * Runs the actual migration SQL against an embedded `@electric-sql/pglite`
 * Postgres instance (same technique as
 * `../../lib/pay/__tests__/pglite-pay-harness.ts` and
 * `./bug-reports-tracker-migration.test.ts`) so this proves the backfill and
 * the idempotent re-run behave against real Postgres array semantics — not
 * just that the SQL file parses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/** Walk upward from this file to find the repo-root `migrations/` directory. */
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
    `registry-apps-redirect-uris-migration.test.ts: could not locate the repo's migrations/ directory by walking up from ${import.meta.url}`,
  );
}

const migrationsDir = findRepoMigrationsDir();
function readMigration(filename: string): string {
  return readFileSync(join(migrationsDir, filename), 'utf-8');
}

const SEED = readMigration('0001_seed.sql');
const REGISTRY_APPS = readMigration('0007_registry_apps.sql');
const REDIRECT_URIS = readMigration('0158_registry_apps_redirect_uris.sql');

let client: PGlite;

afterEach(async () => {
  await client?.close();
});

interface SeedRow {
  id: string;
  callbackUrl: string | null;
}

async function seedApp(row: Readonly<SeedRow>): Promise<void> {
  await client.query(
    `INSERT INTO registry.apps
       (id, owner_did, name, app_did, public_key, callback_url)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.id, 'did:imajin:owner', 'Test App', `did:imajin:${row.id}`, `pk_${row.id}`, row.callbackUrl],
  );
}

describe('0158_registry_apps_redirect_uris (#1348)', () => {
  it('backfills redirect_uris from callback_url, skips blank/null callback_url, and is idempotent on re-run', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await client.exec(REGISTRY_APPS);

    await seedApp({ id: 'app_one', callbackUrl: 'https://claude.ai/api/mcp/auth_callback' });
    await seedApp({ id: 'app_blank', callbackUrl: '' });

    await client.exec(REDIRECT_URIS);

    type Row = { id: string; redirect_uris: string[] };
    const firstRun = await client.query<Row>(
      'SELECT id, redirect_uris FROM registry.apps ORDER BY id',
    );

    expect(firstRun.rows.find((r) => r.id === 'app_one')).toMatchObject({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(firstRun.rows.find((r) => r.id === 'app_blank')).toMatchObject({
      redirect_uris: [],
    });

    // Idempotency: re-running the exact same migration file must not error,
    // and must not perturb already-backfilled data (the `WHERE redirect_uris
    // = '{}'` guard makes the UPDATE a no-op the second time).
    await expect(client.exec(REDIRECT_URIS)).resolves.not.toThrow();

    const secondRun = await client.query<Row>(
      'SELECT id, redirect_uris FROM registry.apps ORDER BY id',
    );
    expect(secondRun.rows).toEqual(firstRun.rows);
  });

  it('does not clobber a manually-populated redirect_uris on re-run (guarded by the empty-array check)', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await client.exec(REGISTRY_APPS);
    await seedApp({ id: 'app_multi', callbackUrl: 'http://localhost:6274/oauth/callback' });
    await client.exec(REDIRECT_URIS);

    // Simulate a client that later registered a second redirect_uri via DCR.
    await client.query(
      `UPDATE registry.apps SET redirect_uris = $1 WHERE id = 'app_multi'`,
      [['http://localhost:6274/oauth/callback', 'http://localhost:6274/oauth/callback/debug']],
    );

    await expect(client.exec(REDIRECT_URIS)).resolves.not.toThrow();

    const row = await client.query<{ redirect_uris: string[] }>(
      `SELECT redirect_uris FROM registry.apps WHERE id = 'app_multi'`,
    );
    expect(row.rows[0]).toMatchObject({
      redirect_uris: ['http://localhost:6274/oauth/callback', 'http://localhost:6274/oauth/callback/debug'],
    });
  });
});
