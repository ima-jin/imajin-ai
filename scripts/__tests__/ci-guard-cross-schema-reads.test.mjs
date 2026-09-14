import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../ci-guard-cross-schema-reads.mjs', import.meta.url));

const OWNERSHIP_MAP = {
  tables: {
    'learn.courses': { owner: 'learn', schema: 'learn', firstMigration: '0001_seed.sql', notes: '' },
    'auth.identities': { owner: 'kernel', schema: 'auth', firstMigration: '0001_seed.sql', notes: '' },
    'profile.profiles': { owner: 'kernel', schema: 'profile', firstMigration: '0001_seed.sql', notes: '' },
    'connections.pod_members': { owner: 'kernel', schema: 'connections', firstMigration: '0001_seed.sql', notes: '' },
  },
  views: {},
  types: {},
  functions: {},
};

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cross-schema-guard-'));
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'kernel', 'app'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'learn', 'app', 'api'), { recursive: true });
  writeFileSync(join(dir, 'migrations', 'ownership.json'), JSON.stringify(OWNERSHIP_MAP, null, 2), 'utf8');
  return dir;
}

function writeSource(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function writeAllowlist(dir, violations) {
  writeFileSync(join(dir, 'migrations', 'cross-schema-allowlist.json'), JSON.stringify({ violations }, null, 2), 'utf8');
}

function runGuard(dir, extraArgs = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...extraArgs], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, CI_GUARD_WORKDIR: dir },
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

/** Runs the guard against `dir` and asserts it exits 0 with a PASS message. */
function expectPass(dir) {
  const result = runGuard(dir);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PASS');
}

/** Runs the guard against `dir` and asserts it exits 1, reporting FAIL and every expected substring. */
function expectFail(dir, ...expectedSubstrings) {
  const result = runGuard(dir);
  const output = result.stdout + result.stderr;
  expect(result.status).toBe(1);
  expect(output).toContain('FAIL');
  for (const substring of expectedSubstrings) {
    expect(output).toContain(substring);
  }
  return output;
}

// Table-driven: every case here writes exactly one source file and asserts a
// simple pass/fail outcome. Kept as data (not individual `it` bodies) so the
// near-identical "write one file, assert pass/fail" shape isn't duplicated
// per case.
const SINGLE_FILE_CASES = [
  {
    name: 'passes when an app only queries its own schema',
    file: 'apps/learn/app/api/route.ts',
    content: "const rows = await sql`SELECT * FROM learn.courses WHERE id = ${id}`;",
    expectedFailSubstrings: null,
  },
  {
    name: "fails when an app reads another owner's schema via raw SQL",
    file: 'apps/learn/app/api/route.ts',
    content: "const rows = await sql`SELECT did FROM profile.profiles WHERE did = ANY(${dids})`;",
    expectedFailSubstrings: ['profile.profiles'],
  },
  {
    name: 'exempts apps/kernel entirely',
    file: 'apps/kernel/app/route.ts',
    content: "const rows = await sql`SELECT * FROM profile.profiles WHERE did = ${did}`;",
    expectedFailSubstrings: null,
  },
  {
    name: 'does not flag plain property access that happens to look like schema.table',
    file: 'apps/learn/app/api/route.ts',
    content: "if ('error' in authResult) { return errorResponse(authResult.error, authResult.status); }",
    expectedFailSubstrings: null,
  },
  {
    name: 'ignores a schema reference inside a comment',
    file: 'apps/learn/app/api/route.ts',
    content: '// this used to read FROM profile.profiles directly\nconst x = 1;',
    expectedFailSubstrings: null,
  },
  {
    name: 'excludes test files from scanning',
    file: 'apps/learn/app/api/__tests__/route.test.ts',
    content: "const rows = await sql`SELECT * FROM profile.profiles WHERE did = ${did}`;",
    expectedFailSubstrings: null,
  },
  {
    name: 'flags a Drizzle pgSchema() declaration for a schema the app does not own',
    file: 'apps/learn/src/db/foreign-schema.ts',
    content: "import { pgSchema } from 'drizzle-orm/pg-core';\nexport const authSchema = pgSchema('auth');",
    expectedFailSubstrings: ['pgSchema("auth")'],
  },
  {
    name: "does not flag a Drizzle pgSchema() declaration for the app's own schema",
    file: 'apps/learn/src/db/schema.ts',
    content: "import { pgSchema } from 'drizzle-orm/pg-core';\nexport const learnSchema = pgSchema('learn');",
    expectedFailSubstrings: null,
  },
];

describe('ci-guard-cross-schema-reads', () => {
  for (const testCase of SINGLE_FILE_CASES) {
    it(testCase.name, () => {
      const dir = makeTempRepo();
      writeSource(dir, testCase.file, testCase.content);

      if (testCase.expectedFailSubstrings) {
        expectFail(dir, ...testCase.expectedFailSubstrings);
      } else {
        expectPass(dir);
      }
    });
  }

  it('detects INTO/UPDATE/JOIN keywords, not just FROM', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/insert-route.ts',
      "await sql`INSERT INTO auth.identities (id) VALUES (${id})`;",
    );
    writeSource(
      dir,
      'apps/learn/app/api/update-route.ts',
      "await sql`UPDATE connections.pod_members SET role = 'x' WHERE did = ${did}`;",
    );

    expectFail(dir, 'auth.identities', 'connections.pod_members');
  });

  it('passes when the only violation is in the allowlist', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "const rows = await sql`SELECT did FROM profile.profiles WHERE did = ANY(${dids})`;",
    );
    writeAllowlist(dir, [{ file: 'apps/learn/app/api/route.ts', schema: 'profile', table: 'profiles' }]);

    expectPass(dir);
  });

  it('still fails on a NEW violation in the same file even when a different table is allowlisted', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "const a = await sql`SELECT did FROM profile.profiles WHERE did = ${did}`;\n" +
        "const b = await sql`SELECT id FROM auth.identities WHERE id = ${did}`;",
    );
    writeAllowlist(dir, [{ file: 'apps/learn/app/api/route.ts', schema: 'profile', table: 'profiles' }]);

    expectFail(dir, 'auth.identities');
  });

  it('--list prints every violation as JSON regardless of the allowlist', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "const rows = await sql`SELECT did FROM profile.profiles WHERE did = ANY(${dids})`;",
    );
    writeAllowlist(dir, [{ file: 'apps/learn/app/api/route.ts', schema: 'profile', table: 'profiles' }]);

    const result = runGuard(dir, ['--list']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ schema: 'profile', table: 'profiles' });
  });
});
