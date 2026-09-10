import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../check-migration-ownership.mjs', import.meta.url));

const BASE_OWNERSHIP = {
  tables: {
    'auth.identities': { owner: 'kernel', schema: 'auth', firstMigration: '0001_seed.sql', notes: '' },
    'coffee.pages': { owner: 'coffee', schema: 'coffee', firstMigration: '0001_seed.sql', notes: '' },
  },
  views: {},
  types: {},
  functions: {},
  sharedMigrationAllowlist: ['0001_seed.sql'],
};

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** Sets up a temp repo with a base commit containing migrations/ownership.json and one seed migration. */
function makeBaseRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-ownership-guard-'));
  mkdirSync(join(dir, 'migrations'), { recursive: true });

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  writeFileSync(join(dir, 'migrations', 'ownership.json'), `${JSON.stringify(BASE_OWNERSHIP, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(dir, 'migrations', '0001_seed.sql'),
    'CREATE TABLE IF NOT EXISTS auth.identities (did TEXT PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS coffee.pages (id SERIAL PRIMARY KEY);\n',
    'utf8',
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);

  const baseRef = git(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, baseRef };
}

function writeMigration(dir, filename, content) {
  writeFileSync(join(dir, 'migrations', filename), content, 'utf8');
}

function writeOwnership(dir, ownership) {
  writeFileSync(join(dir, 'migrations', 'ownership.json'), `${JSON.stringify(ownership, null, 2)}\n`, 'utf8');
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

/** Writes and commits a single migration file in one step — the common case for every scenario below. */
function addMigration(dir, filename, content) {
  writeMigration(dir, filename, content);
  commitAll(dir, `add ${filename}`);
}

function runGuard(dir, baseRef) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: dir,
      env: {
        ...process.env,
        NODE_PATH: join(process.cwd(), 'node_modules'),
        CI_GUARD_WORKDIR: dir,
        MIGRATION_OWNERSHIP_BASE_REF: baseRef,
      },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

function expectPass(result) {
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PASS');
}

function expectFail(result, ...expectedSubstrings) {
  expect(result.status).toBe(1);
  const combined = result.stdout + result.stderr;
  expect(combined).toContain('FAIL');
  for (const substring of expectedSubstrings) {
    expect(combined).toContain(substring);
  }
}

describe('check-migration-ownership', () => {
  it('passes on a clean tree with no changed migration files', () => {
    const { dir, baseRef } = makeBaseRepo();
    expectPass(runGuard(dir, baseRef));
  });

  it('fails when a cross-owner migration alters a table it does not own', () => {
    const { dir, baseRef } = makeBaseRepo();
    addMigration(dir, '0002_events_touches_auth.sql', '-- owner: events\nALTER TABLE auth.identities ADD COLUMN foo TEXT;\n');
    expectFail(runGuard(dir, baseRef), 'auth.identities', 'owned by "kernel"');
  });

  it('passes when a same-owner migration alters a table it owns', () => {
    const { dir, baseRef } = makeBaseRepo();
    addMigration(dir, '0002_kernel_touches_auth.sql', '-- owner: kernel\nALTER TABLE auth.identities ADD COLUMN foo TEXT;\n');
    expectPass(runGuard(dir, baseRef));
  });

  it('fails when a new migration has no "-- owner:" header', () => {
    const { dir, baseRef } = makeBaseRepo();
    addMigration(dir, '0002_no_header.sql', 'CREATE TABLE IF NOT EXISTS events.foo (id SERIAL PRIMARY KEY);\n');
    expectFail(runGuard(dir, baseRef), 'missing a "-- owner:');
  });

  it('fails when a new migration creates a table not registered in ownership.json', () => {
    const { dir, baseRef } = makeBaseRepo();
    addMigration(
      dir,
      '0002_events_new_table.sql',
      '-- owner: events\nCREATE TABLE IF NOT EXISTS events.new_table (id SERIAL PRIMARY KEY);\n',
    );
    expectFail(runGuard(dir, baseRef), 'events.new_table', 'not registered');
  });

  it('passes when a new table is created and registered in ownership.json in the same PR', () => {
    const { dir, baseRef } = makeBaseRepo();
    writeMigration(
      dir,
      '0002_events_new_table.sql',
      '-- owner: events\nCREATE TABLE IF NOT EXISTS events.new_table (id SERIAL PRIMARY KEY);\n',
    );
    writeOwnership(dir, {
      ...BASE_OWNERSHIP,
      tables: {
        ...BASE_OWNERSHIP.tables,
        'events.new_table': { owner: 'events', schema: 'events', firstMigration: '0002_events_new_table.sql', notes: '' },
      },
    });
    commitAll(dir, 'events adds and registers a new table');
    expectPass(runGuard(dir, baseRef));
  });

  it('grandfathers a pre-existing headerless migration that is merely touched, not added', () => {
    const { dir, baseRef } = makeBaseRepo();
    // 0001_seed.sql already exists in the base commit with no "-- owner:" header.
    // Appending a comment makes it a "modified" (M) file, not "added" (A).
    const existing = readFileSync(join(dir, 'migrations', '0001_seed.sql'), 'utf8');
    addMigration(dir, '0001_seed.sql', `${existing}\n-- trailing comment, no functional change\n`);
    expectPass(runGuard(dir, baseRef));
  });

  it('rejects an unknown declared owner', () => {
    const { dir, baseRef } = makeBaseRepo();
    addMigration(dir, '0002_bad_owner.sql', '-- owner: not-a-real-app\nCREATE TABLE IF NOT EXISTS events.foo (id SERIAL PRIMARY KEY);\n');
    expectFail(runGuard(dir, baseRef), 'not a known owner');
  });

  it('fails a new migration whose DDL touches more than one owner\'s schema', () => {
    const { dir, baseRef } = makeBaseRepo();
    addMigration(
      dir,
      '0002_two_owners.sql',
      '-- owner: events\nCREATE TABLE IF NOT EXISTS events.foo (id SERIAL PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS coffee.bar (id SERIAL PRIMARY KEY);\n',
    );
    expectFail(runGuard(dir, baseRef), 'touches more than one', 'coffee', 'events');
  });

  it('fails a new migration whose only cross-owner reference is DML (no DDL at all)', () => {
    const { dir, baseRef } = makeBaseRepo();
    // Mirrors migrations/0025_backfill_survey_responses_for_orphan_registrations.sql:
    // zero DDL, but a real cross-schema UPDATE/JOIN — must still be caught.
    addMigration(
      dir,
      '0002_dml_only_cross_owner.sql',
      '-- owner: coffee\nUPDATE coffee.pages p SET id = a.id FROM auth.identities a WHERE p.id = a.id;\n',
    );
    expectFail(runGuard(dir, baseRef), 'touches more than one');
  });

  it('passes a new shared migration that is explicitly on the sharedMigrationAllowlist', () => {
    const { dir, baseRef } = makeBaseRepo();
    // DML-only, like the real 0025/0026 exception shape: no DDL touch at all,
    // so the per-table check (which only looks at parsed DDL) has nothing to
    // say — only the new shared-schema check applies, and the allowlist is
    // what lets it pass.
    writeMigration(
      dir,
      '0002_cross_owner_backfill.sql',
      '-- owner: coffee\nUPDATE coffee.pages p SET id = a.id FROM auth.identities a WHERE p.id = a.id;\n',
    );
    writeOwnership(dir, {
      ...BASE_OWNERSHIP,
      sharedMigrationAllowlist: [...BASE_OWNERSHIP.sharedMigrationAllowlist, '0002_cross_owner_backfill.sql'],
    });
    commitAll(dir, 'deliberate cross-owner backfill, allowlisted');
    expectPass(runGuard(dir, baseRef));
  });

  it('reports both a shared-schema violation and a per-table violation when a single new file has both', () => {
    const { dir, baseRef } = makeBaseRepo();
    // Declared owner 'coffee', creates a table it legitimately owns (coffee.new_thing)
    // but also touches a kernel-owned table (auth.identities) — both the
    // shared-schema check and the per-table check should fire independently.
    addMigration(
      dir,
      '0002_mixed_violation.sql',
      '-- owner: coffee\nCREATE TABLE IF NOT EXISTS coffee.new_thing (id SERIAL PRIMARY KEY);\nALTER TABLE auth.identities ADD COLUMN foo TEXT;\n',
    );
    const result = runGuard(dir, baseRef);
    expectFail(result, 'touches more than one', 'owned by "kernel"');
  });
});
