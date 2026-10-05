import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_TABLE,
  SchemaMismatchError,
  assertAppSchema,
  assertFileStaysInSchema,
  listAppMigrations,
  parseRunnerArgs,
  runAppMigrations,
} from '../lib/migrate-app-mode.mjs';

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app-migrations');
const silent = { log: vi.fn(), warn: vi.fn() };

/**
 * Minimal in-memory stand-in for a postgres.js client: records every
 * statement and simulates the per-schema ledger table.
 */
function createFakeSql(initialLedger = []) {
  const ledger = new Map(initialLedger.map(r => [r.filename, r.checksum]));
  const calls = [];

  function makeTag(scope) {
    const tag = (first, ...values) => {
      if (!Array.isArray(first)) return { identifier: first }; // sql('schema.table')
      const text = first.join('?').replace(/\s+/g, ' ').trim();
      const rendered = values.map(v => (v && v.identifier ? v.identifier : v));
      calls.push({ scope, text, values: rendered });
      if (text.startsWith('SELECT filename, checksum')) {
        return Promise.resolve([...ledger].map(([filename, checksum]) => ({ filename, checksum })));
      }
      if (text.startsWith('INSERT INTO')) {
        ledger.set(rendered[1], rendered[2]);
      }
      return Promise.resolve([]);
    };
    tag.unsafe = content => {
      calls.push({ scope, text: 'UNSAFE', values: [content] });
      return Promise.resolve([]);
    };
    return tag;
  }

  const sql = makeTag('top');
  sql.begin = async fn => {
    calls.push({ scope: 'tx', text: 'BEGIN', values: [] });
    const result = await fn(makeTag('tx'));
    calls.push({ scope: 'tx', text: 'COMMIT', values: [] });
    return result;
  };
  return { sql, calls, ledger };
}

describe('assertAppSchema', () => {
  it('accepts a plain app schema name, including ones unknown to the kernel', () => {
    expect(assertAppSchema('links')).toBe('links');
    expect(assertAppSchema('fixture_app')).toBe('fixture_app');
  });

  it('rejects every kernel schema with a SchemaMismatchError', () => {
    for (const schema of ['auth', 'kernel', 'registry', 'pay', 'relay']) {
      expect(() => assertAppSchema(schema)).toThrow(SchemaMismatchError);
      expect(() => assertAppSchema(schema)).toThrow(/kernel-owned schema/);
    }
  });

  it('rejects reserved Postgres schemas', () => {
    expect(() => assertAppSchema('public')).toThrow(/reserved Postgres schema/);
    expect(() => assertAppSchema('information_schema')).toThrow(SchemaMismatchError);
    expect(() => assertAppSchema('pg_catalog')).toThrow(SchemaMismatchError);
  });

  it('rejects malformed names (so a name can never be an injection vector)', () => {
    for (const bad of ['', 'Links', '1links', 'a-b', 'a;drop schema x', 'a"b', undefined, null]) {
      expect(() => assertAppSchema(bad)).toThrow(/invalid --schema/);
    }
  });
});

describe('assertFileStaysInSchema', () => {
  it('passes a file that only touches its own schema', () => {
    expect(() =>
      assertFileStaysInSchema('a.sql', 'CREATE TABLE IF NOT EXISTS links.pages (id INT);', 'links'),
    ).not.toThrow();
  });

  it('passes a file with unqualified names and no known schema references', () => {
    expect(() => assertFileStaysInSchema('a.sql', 'ALTER TABLE pages ADD COLUMN x INT;', 'links')).not.toThrow();
  });

  it('ignores foreign schema names inside comments and string literals', () => {
    const sql = "-- see auth.identities\nINSERT INTO links.t (v) VALUES ('auth.identities');";
    expect(() => assertFileStaysInSchema('a.sql', sql, 'links')).not.toThrow();
  });

  it('fails loud on a kernel schema reference', () => {
    expect(() =>
      assertFileStaysInSchema('0003_x.sql', 'SELECT * FROM auth.identities, links.pages;', 'links'),
    ).toThrow(/0003_x\.sql references schema\(s\) auth outside/);
  });

  it('fails loud on another app schema reference and lists all offenders sorted', () => {
    const err = (() => {
      try {
        assertFileStaysInSchema('b.sql', 'SELECT 1 FROM market.a JOIN dykil.b ON true;', 'links');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(SchemaMismatchError);
    expect(err.message).toMatch(/dykil, market/);
  });
});

describe('parseRunnerArgs', () => {
  it('returns null app fields and the phase-2a result for non-app argv (default unchanged)', () => {
    expect(parseRunnerArgs([])).toEqual({ owner: null, includeShared: false, appDir: null, schema: null });
    expect(parseRunnerArgs(['--owner', 'links', '--include-shared'])).toEqual({
      owner: 'links',
      includeShared: true,
      appDir: null,
      schema: null,
    });
  });

  it('parses --app-dir and --schema as separate argv entries', () => {
    expect(parseRunnerArgs(['--app-dir', './migrations', '--schema', 'links'])).toEqual({
      owner: null,
      includeShared: false,
      appDir: './migrations',
      schema: 'links',
    });
  });

  it('parses --flag=value forms in either order', () => {
    expect(parseRunnerArgs(['--schema=links', '--app-dir=./m'])).toMatchObject({ appDir: './m', schema: 'links' });
  });

  it('requires both app flags together', () => {
    expect(() => parseRunnerArgs(['--app-dir', './m'])).toThrow(/must be given together/);
    expect(() => parseRunnerArgs(['--schema', 'links'])).toThrow(/must be given together/);
  });

  it('rejects a missing flag value', () => {
    expect(() => parseRunnerArgs(['--app-dir'])).toThrow(/--app-dir requires a value/);
    expect(() => parseRunnerArgs(['--app-dir', '--schema', 'links'])).toThrow(/--app-dir requires a value/);
  });

  it('rejects empty values from the = form', () => {
    expect(() => parseRunnerArgs(['--app-dir=', '--schema=links'])).toThrow(/must not be empty/);
  });

  it('rejects combining app mode with --owner', () => {
    expect(() => parseRunnerArgs(['--app-dir', './m', '--schema', 'links', '--owner', 'links'])).toThrow(
      /cannot be combined/,
    );
  });

  it('rejects a kernel schema before any database work', () => {
    expect(() => parseRunnerArgs(['--app-dir', './m', '--schema', 'auth'])).toThrow(SchemaMismatchError);
    expect(() => parseRunnerArgs(['--app-dir', './m', '--schema', 'public'])).toThrow(SchemaMismatchError);
  });

  it('still rejects unknown arguments', () => {
    expect(() => parseRunnerArgs(['--bogus'])).toThrow(/unrecognized argument/);
  });
});

describe('listAppMigrations', () => {
  it('lists only .sql files, sorted by name', () => {
    expect(listAppMigrations(fixtureDir)).toEqual(['0001_init.sql', '0002_add_title.sql']);
  });

  it('throws when the directory does not exist or is a file', () => {
    expect(() => listAppMigrations(join(fixtureDir, 'nope'))).toThrow(/is not a directory/);
    expect(() => listAppMigrations(join(fixtureDir, '0001_init.sql'))).toThrow(/is not a directory/);
  });
});

describe('runAppMigrations', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'app-migrations-'));
    silent.log.mockClear();
    silent.warn.mockClear();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('applies every pending file in order, each in its own transaction with search_path pinned', async () => {
    const { sql, calls, ledger } = createFakeSql();
    const count = await runAppMigrations({ sql, dir: fixtureDir, schema: 'fixture_app', logger: silent });

    expect(count).toBe(2);
    expect([...ledger.keys()]).toEqual(['0001_init.sql', '0002_add_title.sql']);

    const texts = calls.map(c => c.text);
    expect(texts.filter(t => t === 'BEGIN')).toHaveLength(2);
    expect(texts.filter(t => t === 'COMMIT')).toHaveLength(2);
    const txCalls = calls.filter(c => c.scope === 'tx');
    expect(txCalls[1].text).toMatch(/^SELECT set_config\('search_path', \?, true\)$/);
    expect(txCalls[1].values).toEqual(['fixture_app']);
    expect(txCalls[2].text).toBe('UNSAFE');
    expect(txCalls[2].values[0]).toMatch(/CREATE TABLE IF NOT EXISTS fixture_app\.pages/);
    // Ledger lives inside the app schema, never public._migrations.
    const ledgerWrites = calls.filter(c => c.text.startsWith('INSERT INTO'));
    expect(ledgerWrites.map(c => c.values[0])).toEqual([`fixture_app.${LEDGER_TABLE}`, `fixture_app.${LEDGER_TABLE}`]);
    expect(calls.some(c => JSON.stringify(c).includes('public._migrations'))).toBe(false);
  });

  it('creates the schema and ledger before reading it', async () => {
    const { sql, calls } = createFakeSql();
    await runAppMigrations({ sql, dir: fixtureDir, schema: 'fixture_app', logger: silent });
    expect(calls[0].text).toBe('CREATE SCHEMA IF NOT EXISTS ?');
    expect(calls[0].values).toEqual(['fixture_app']);
    expect(calls[1].text).toMatch(/^CREATE TABLE IF NOT EXISTS \? \(/);
    expect(calls[2].text).toMatch(/^SELECT filename, checksum FROM \?/);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const fake = createFakeSql();
    await runAppMigrations({ sql: fake.sql, dir: fixtureDir, schema: 'fixture_app', logger: silent });
    const before = fake.calls.length;
    const count = await runAppMigrations({ sql: fake.sql, dir: fixtureDir, schema: 'fixture_app', logger: silent });

    expect(count).toBe(0);
    expect(fake.calls.slice(before).some(c => c.scope === 'tx')).toBe(false);
    expect(silent.log).toHaveBeenCalledWith(expect.stringMatching(/All "fixture_app" migrations already applied/));
  });

  it('warns and skips a file whose checksum changed since it was applied', async () => {
    writeFileSync(join(tmp, '0001_a.sql'), 'CREATE TABLE IF NOT EXISTS app_x.t (id INT);');
    const { sql, calls } = createFakeSql([{ filename: '0001_a.sql', checksum: 'stale' }]);
    const count = await runAppMigrations({ sql, dir: tmp, schema: 'app_x', logger: silent });

    expect(count).toBe(0);
    expect(calls.some(c => c.scope === 'tx')).toBe(false);
    expect(silent.warn).toHaveBeenCalledWith(expect.stringMatching(/0001_a\.sql — checksum changed/));
  });

  it('applies only the new file when earlier ones are already in the ledger', async () => {
    const first = createFakeSql();
    await runAppMigrations({ sql: first.sql, dir: fixtureDir, schema: 'fixture_app', logger: silent });
    const partial = createFakeSql([...first.ledger].slice(0, 1).map(([filename, checksum]) => ({ filename, checksum })));
    const count = await runAppMigrations({ sql: partial.sql, dir: fixtureDir, schema: 'fixture_app', logger: silent });
    expect(count).toBe(1);
    expect([...partial.ledger.keys()]).toEqual(['0001_init.sql', '0002_add_title.sql']);
  });

  it('fails loud on a schema mismatch before executing ANY file (no partial migration)', async () => {
    writeFileSync(join(tmp, '0001_ok.sql'), 'CREATE TABLE IF NOT EXISTS app_x.t (id INT);');
    writeFileSync(join(tmp, '0002_bad.sql'), 'INSERT INTO auth.identities (did) VALUES (\'x\');');
    const { sql, calls } = createFakeSql();

    await expect(runAppMigrations({ sql, dir: tmp, schema: 'app_x', logger: silent })).rejects.toThrow(
      /0002_bad\.sql references schema\(s\) auth/,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a kernel schema target without touching the database', async () => {
    const { sql, calls } = createFakeSql();
    await expect(runAppMigrations({ sql, dir: fixtureDir, schema: 'auth', logger: silent })).rejects.toThrow(
      SchemaMismatchError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a missing migrations directory without touching the database', async () => {
    const { sql, calls } = createFakeSql();
    await expect(
      runAppMigrations({ sql, dir: join(tmp, 'missing'), schema: 'app_x', logger: silent }),
    ).rejects.toThrow(/is not a directory/);
    expect(calls).toHaveLength(0);
  });

  it('propagates a failing migration and records nothing for it', async () => {
    writeFileSync(join(tmp, '0001_a.sql'), 'SELECT 1;');
    const { sql, ledger } = createFakeSql();
    const failing = Object.assign((...args) => sql(...args), sql, {
      begin: async () => {
        throw new Error('boom');
      },
    });
    await expect(runAppMigrations({ sql: failing, dir: tmp, schema: 'app_x', logger: silent })).rejects.toThrow('boom');
    expect(ledger.size).toBe(0);
  });
});
