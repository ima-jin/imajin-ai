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

describe('ci-guard-cross-schema-reads', () => {
  it('passes when an app only queries its own schema', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "const rows = await sql`SELECT * FROM learn.courses WHERE id = ${id}`;",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('fails when an app reads another owner\'s schema via raw SQL', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "const rows = await sql`SELECT did FROM profile.profiles WHERE did = ANY(${dids})`;",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('FAIL');
    expect(result.stdout + result.stderr).toContain('profile.profiles');
  });

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

    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('auth.identities');
    expect(result.stdout + result.stderr).toContain('connections.pod_members');
  });

  it('exempts apps/kernel entirely', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/kernel/app/route.ts',
      "const rows = await sql`SELECT * FROM profile.profiles WHERE did = ${did}`;",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('does not flag plain property access that happens to look like schema.table', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "if ('error' in authResult) { return errorResponse(authResult.error, authResult.status); }",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('ignores a schema reference inside a comment', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "// this used to read FROM profile.profiles directly\nconst x = 1;",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('excludes test files from scanning', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/__tests__/route.test.ts',
      "const rows = await sql`SELECT * FROM profile.profiles WHERE did = ${did}`;",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('passes when the only violation is in the allowlist', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/app/api/route.ts',
      "const rows = await sql`SELECT did FROM profile.profiles WHERE did = ANY(${dids})`;",
    );
    writeAllowlist(dir, [{ file: 'apps/learn/app/api/route.ts', schema: 'profile', table: 'profiles' }]);

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
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

    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('auth.identities');
  });

  it('flags a Drizzle pgSchema() declaration for a schema the app does not own', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/src/db/foreign-schema.ts',
      "import { pgSchema } from 'drizzle-orm/pg-core';\nexport const authSchema = pgSchema('auth');",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('pgSchema("auth")');
  });

  it('does not flag a Drizzle pgSchema() declaration for the app\'s own schema', () => {
    const dir = makeTempRepo();
    writeSource(
      dir,
      'apps/learn/src/db/schema.ts',
      "import { pgSchema } from 'drizzle-orm/pg-core';\nexport const learnSchema = pgSchema('learn');",
    );

    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
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
