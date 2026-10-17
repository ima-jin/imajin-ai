import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const ARCHIVE = 'archive/pre-kernel-baseline';
const BASELINE = '0001_kernel_baseline.sql';

function writeBaselineManifest(dir) {
  const filename = '0001_seed.sql';
  const checksum = createHash('sha256').update(readFileSync(join(dir, 'migrations', ARCHIVE, filename))).digest('hex');
  writeMigration(dir, 'kernel-baseline.json', JSON.stringify({
    filename: BASELINE, archive: ARCHIVE,
    migrations: [{ filename, checksum }], schemas: ['auth'], seeds: [],
  }));
}

function activateBaseline(dir, sql = '-- owner: kernel\nCREATE TABLE auth.identities (did TEXT PRIMARY KEY);\n') {
  mkdirSync(join(dir, 'migrations', ARCHIVE), { recursive: true });
  renameSync(join(dir, 'migrations', '0001_seed.sql'), join(dir, 'migrations', ARCHIVE, '0001_seed.sql'));
  writeMigration(dir, BASELINE, sql);
  writeBaselineManifest(dir);
  commitAll(dir, 'activate kernel baseline');
}

describe('kernel baseline ownership boundary', () => {
  it('permits byte-identical history moves, despite app SQL and missing headers in that history', () => {
    const { dir, baseRef } = makeBaseRepo();
    activateBaseline(dir);
    expectPass(runGuard(dir, baseRef));
  });

  it.each([
    'SELECT * FROM events.events;',
    'SELECT * FROM "links" . "clicks";',
    'CREATE SCHEMA IF NOT EXISTS events;',
    'DROP SCHEMA links CASCADE;',
    "SET search_path TO 'events'; SELECT * FROM events;",
    'ALTER TABLE auth.identities SET SCHEMA links;',
    'DO $$ BEGIN DELETE FROM events.events; END $$;',
  ])('rejects baseline app schema leakage: %s', (statement) => {
    const { dir, baseRef } = makeBaseRepo();
    activateBaseline(dir, `-- owner: kernel\n${statement}\n`);
    expectFail(runGuard(dir, baseRef), 'externally owned');
  });

  it.each(['', '-- owner: events\n'])('requires kernel ownership even on the baseline: %s', (header) => {
    const { dir, baseRef } = makeBaseRepo();
    activateBaseline(dir, `${header}SELECT 1;\n`);
    expectFail(runGuard(dir, baseRef), 'must declare "-- owner: kernel"');
  });

  it('rejects altered history even when its manifest checksum is updated to match', () => {
    const { dir, baseRef } = makeBaseRepo();
    activateBaseline(dir);
    writeMigration(dir, `${ARCHIVE}/0001_seed.sql`, 'SELECT 1;\n');
    writeBaselineManifest(dir);
    commitAll(dir, 'tamper with archive and manifest');
    expectFail(runGuard(dir, baseRef), 'archive history is immutable');
  });

  it('rejects archive copies when the original root SQL is not removed', () => {
    const { dir, baseRef } = makeBaseRepo();
    activateBaseline(dir);
    writeMigration(dir, '0001_seed.sql', readFileSync(join(dir, 'migrations', ARCHIVE, '0001_seed.sql'), 'utf8'));
    commitAll(dir, 'restore original instead of moving it');
    expectFail(runGuard(dir, baseRef), 'archive history is immutable');
  });

  it.each(['edit', 'delete', 'add'])('rejects subsequent archive %s even with an edited manifest', (operation) => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    const baseRef = git(dir, ['rev-parse', 'HEAD']).trim();
    const archiveFile = join(dir, 'migrations', ARCHIVE, '0001_seed.sql');
    if (operation === 'delete') unlinkSync(archiveFile);
    if (operation === 'edit') {
      writeMigration(dir, `${ARCHIVE}/0001_seed.sql`, 'SELECT 1;\n');
      writeBaselineManifest(dir);
    }
    if (operation === 'add') {
      writeMigration(dir, `${ARCHIVE}/9999_new.sql`, 'SELECT 1;\n');
      const path = join(dir, 'migrations', 'kernel-baseline.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.migrations.push({ filename: '9999_new.sql', checksum: createHash('sha256').update('SELECT 1;\n').digest('hex') });
      writeFileSync(path, JSON.stringify(manifest));
    }
    commitAll(dir, `archive ${operation}`);
    expectFail(runGuard(dir, baseRef), 'archive history is immutable');
  });

  it('checks archive checksums even on manifest-only changes', () => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    const baseRef = git(dir, ['rev-parse', 'HEAD']).trim();
    const path = join(dir, 'migrations', 'kernel-baseline.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.migrations[0].checksum = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(manifest));
    commitAll(dir, 'wrong checksum');
    expectFail(runGuard(dir, baseRef), 'checksum does not match');
  });

  it('cannot reopen the archive by moving a future root migration and updating the manifest', () => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    addMigration(dir, '0202_future.sql', '-- owner: kernel\nSELECT 1;\n');
    const baseRef = git(dir, ['rev-parse', 'HEAD']).trim();
    renameSync(join(dir, 'migrations', '0202_future.sql'), join(dir, 'migrations', ARCHIVE, '0202_future.sql'));
    commitAll(dir, 'move future SQL to archive');
    expectFail(runGuard(dir, baseRef), 'archive history is immutable');
  });

  it('cannot disable kernel-only checks by removing the manifest', () => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    const baseRef = git(dir, ['rev-parse', 'HEAD']).trim();
    unlinkSync(join(dir, 'migrations', 'kernel-baseline.json'));
    addMigration(dir, '0202_future.sql', '-- owner: events\nSELECT * FROM events.events;\n');
    expectFail(runGuard(dir, baseRef), 'removing the baseline manifest', 'externally owned');
  });

  it('keeps future root SQL kernel-only even when shared-allowlisted', () => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    const baseRef = git(dir, ['rev-parse', 'HEAD']).trim();
    writeOwnership(dir, { ...BASE_OWNERSHIP, sharedMigrationAllowlist: ['0202_future.sql'] });
    addMigration(dir, '0202_future.sql', '-- owner: kernel\nSELECT * FROM events.events JOIN links.links ON true;\n');
    expectFail(runGuard(dir, baseRef), 'externally owned', 'events', 'links');
  });

  it('rejects app references added to an already-applied baseline', () => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    const baseRef = git(dir, ['rev-parse', 'HEAD']).trim();
    addMigration(dir, BASELINE, '-- owner: kernel\nSELECT * FROM links.links;\n');
    expectFail(runGuard(dir, baseRef), 'externally owned', 'links');
  });

  it('passes future kernel-only SQL and ignores app names in data and comments', () => {
    const { dir, baseRef } = makeBaseRepo();
    activateBaseline(dir);
    addMigration(dir, '0202_future.sql', "-- owner: kernel\n-- DROP SCHEMA events;\nSELECT 'links.links';\n");
    expectPass(runGuard(dir, baseRef));
  });
});

describe('baseline folder consistency', () => {
  function setHistoricalMaximum(dir) {
    const path = join(dir, 'migrations', 'kernel-baseline.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.migrations.push({ filename: '0201_final_history.sql', checksum: '0'.repeat(64) });
    writeFileSync(path, JSON.stringify(manifest));
  }
  function checkFolder(dir) {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'apps'), { recursive: true });
    const source = fileURLToPath(new URL('../check-migrations.sh', import.meta.url));
    const target = join(dir, 'scripts', 'check-migrations.sh');
    writeFileSync(target, readFileSync(source));
    try {
      return { status: 0, output: execFileSync('/bin/bash', [target], { encoding: 'utf8' }) };
    } catch (error) {
      return { status: error.status, output: error.stdout.toString() };
    }
  }

  it('accepts baseline followed by the first number beyond history, without a gap warning', () => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    setHistoricalMaximum(dir);
    writeMigration(dir, '0202_future.sql', '-- owner: kernel\nSELECT 1;\n');
    const result = checkFolder(dir);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain('gap in numbering');
  });

  it('rejects active reuse of archived migration numbers', () => {
    const { dir } = makeBaseRepo();
    activateBaseline(dir);
    setHistoricalMaximum(dir);
    writeMigration(dir, '0002_reuse.sql', 'SELECT 1;\n');
    expect(checkFolder(dir).status).toBe(1);
  });
});
describe('check-migration-ownership', () => {
  const externalSchemas = {
    dykil: { owner: 'dykil', repository: 'ima-jin/dykil' },
    learn: { owner: 'learn', repository: 'ima-jin/learn' },
    coffee: { owner: 'coffee', repository: 'ima-jin/coffee' },
    market: { owner: 'market', repository: 'ima-jin/market' },
  };

  it.each([
    ['dykil', 'ALTER TABLE dykil.surveys ADD COLUMN label TEXT;'],
    ['dykil', 'UPDATE "dykil"."surveys" SET title = title;'],
    ['dykil', 'SELECT * FROM dykil.survey_responses;'],
    ['dykil', 'SELECT * FROM "dykil" . "surveys";'],
    ['dykil', 'CREATE SCHEMA IF NOT EXISTS dykil;'],
    ['dykil', 'DROP SCHEMA "dykil" CASCADE;'],
    ['kernel', 'ALTER TABLE auth.identities SET SCHEMA dykil;'],
    ['kernel', 'UPDATE dykil.surveys SET title = title;'],
    ['dykil', 'SET search_path TO dykil; CREATE TABLE surveys (id text);'],
    ['kernel', "SET LOCAL search_path TO 'dykil', pg_catalog; SELECT * FROM surveys;"],
    ['kernel', 'SET "search_path" TO \'dykil\'; SELECT * FROM surveys;'],
    ['kernel', "SET search_path='dykil'; SELECT * FROM surveys;"],
    ['learn', 'DELETE FROM learn.courses;'],
    ['coffee', 'UPDATE coffee.pages SET id = id;'],
    ['market', 'SELECT * FROM market.listings;'],
  ])('rejects new %s schema access even with the app owner header: %s', (owner, statement) => {
    const { dir, baseRef } = makeBaseRepo();
    writeOwnership(dir, { ...BASE_OWNERSHIP, externalSchemas });
    addMigration(dir, '0002_external.sql', `-- owner: ${owner}\n${statement}\n`);
    expectFail(runGuard(dir, baseRef), 'externally owned');
  });

  it('does not let the shared allowlist bypass external ownership', () => {
    const { dir, baseRef } = makeBaseRepo();
    writeOwnership(dir, {
      ...BASE_OWNERSHIP,
      externalSchemas,
      sharedMigrationAllowlist: ['0001_seed.sql', '0002_external.sql'],
    });
    addMigration(dir, '0002_external.sql', '-- owner: kernel\nSELECT * FROM dykil.surveys JOIN auth.identities ON true;\n');
    expectFail(runGuard(dir, baseRef), 'externally owned', 'ima-jin/dykil');
  });

  it('ignores external schema names in comments and data values', () => {
    const { dir, baseRef } = makeBaseRepo();
    writeOwnership(dir, { ...BASE_OWNERSHIP, externalSchemas });
    addMigration(dir, '0002_kernel.sql', "-- owner: kernel\n-- DROP SCHEMA dykil;\nSELECT 'dykil.surveys', 'SET search_path TO coffee';\n");
    expectPass(runGuard(dir, baseRef));
  });

  it('retains grandfathered history after external ownership is recorded', () => {
    const { dir, baseRef } = makeBaseRepo();
    writeOwnership(dir, { ...BASE_OWNERSHIP, externalSchemas });
    commitAll(dir, 'record external ownership without changing SQL');
    expectPass(runGuard(dir, baseRef));
  });
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
