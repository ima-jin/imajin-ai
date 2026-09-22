/**
 * Real-engine migration coverage for 0154/0155 (#2184): www.bug_reports'
 * generic tracker/external_ref/external_url columns replacing the
 * vendor-named github_issue_number/github_issue_url pair.
 *
 * Runs the actual migration SQL files against an embedded
 * `@electric-sql/pglite` Postgres instance (same technique as
 * `../../lib/pay/__tests__/pglite-pay-harness.ts`) rather than asserting on
 * the SQL text, so this proves the backfill and the idempotent re-run
 * actually behave against real Postgres semantics — not just that the file
 * parses.
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
    `bug-reports-tracker-migration.test.ts: could not locate the repo's migrations/ directory by walking up from ${import.meta.url}`,
  );
}

const migrationsDir = findRepoMigrationsDir();
function readMigration(filename: string): string {
  return readFileSync(join(migrationsDir, filename), 'utf-8');
}

const SEED = readMigration('0001_seed.sql');
const ADD_TRACKER = readMigration('0154_bug_reports_external_tracker.sql');
const DROP_GITHUB_COLUMNS = readMigration('0155_bug_reports_drop_github_columns.sql');

let client: PGlite;

afterEach(async () => {
  await client?.close();
});

interface SeedRow {
  id: string;
  status?: string;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
}

async function seedBugReport(row: Readonly<SeedRow>): Promise<void> {
  await client.query(
    `INSERT INTO www.bug_reports
       (id, reporter_did, type, description, status, github_issue_number, github_issue_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.id,
      'did:imajin:reporter',
      'bug',
      'Something is broken',
      row.status ?? 'new',
      row.githubIssueNumber ?? null,
      row.githubIssueUrl ?? null,
    ],
  );
}

describe('0154_bug_reports_external_tracker (#2184)', () => {
  it('backfills tracker/external_ref/external_url only for imported rows, and is idempotent on re-run', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);

    await seedBugReport({
      id: 'bug_imported',
      status: 'imported',
      githubIssueNumber: 2183,
      githubIssueUrl: 'https://github.com/ima-jin/imajin-ai/issues/2183',
    });
    await seedBugReport({ id: 'bug_new' }); // never imported — no github_issue_number

    await client.exec(ADD_TRACKER);

    type TrackerRow = { id: string; tracker: string | null; external_ref: string | null; external_url: string | null };
    const firstRun = await client.query<TrackerRow>(
      'SELECT id, tracker, external_ref, external_url FROM www.bug_reports ORDER BY id',
    );

    expect(firstRun.rows.find((r) => r.id === 'bug_imported')).toMatchObject({
      tracker: 'github',
      external_ref: 'ima-jin/imajin-ai#2183',
      external_url: 'https://github.com/ima-jin/imajin-ai/issues/2183',
    });
    expect(firstRun.rows.find((r) => r.id === 'bug_new')).toMatchObject({
      tracker: null,
      external_ref: null,
      external_url: null,
    });

    // Idempotency: re-running the exact same migration file must not error,
    // and must not perturb already-backfilled data (the WHERE tracker IS
    // NULL guard makes the UPDATE a no-op the second time).
    await expect(client.exec(ADD_TRACKER)).resolves.not.toThrow();

    const secondRun = await client.query<TrackerRow>(
      'SELECT id, tracker, external_ref, external_url FROM www.bug_reports ORDER BY id',
    );
    expect(secondRun.rows).toEqual(firstRun.rows);
  });
});

describe('0155_bug_reports_drop_github_columns (#2184)', () => {
  it('drops the legacy columns after 0154 has backfilled the generic ones, preserves the backfilled data, and is itself idempotent', async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(SEED);
    await seedBugReport({
      id: 'bug_imported',
      status: 'imported',
      githubIssueNumber: 7,
      githubIssueUrl: 'https://github.com/ima-jin/imajin-ai/issues/7',
    });
    await client.exec(ADD_TRACKER);

    await client.exec(DROP_GITHUB_COLUMNS);

    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'www' AND table_name = 'bug_reports'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).not.toContain('github_issue_number');
    expect(names).not.toContain('github_issue_url');
    expect(names).toEqual(expect.arrayContaining(['tracker', 'external_ref', 'external_url']));

    const row = await client.query<{ tracker: string; external_ref: string }>(
      `SELECT tracker, external_ref FROM www.bug_reports WHERE id = 'bug_imported'`,
    );
    expect(row.rows[0]).toMatchObject({ tracker: 'github', external_ref: 'ima-jin/imajin-ai#7' });

    // Idempotency: re-running the drop migration (DROP COLUMN IF EXISTS) must not error.
    await expect(client.exec(DROP_GITHUB_COLUMNS)).resolves.not.toThrow();
  });
});
