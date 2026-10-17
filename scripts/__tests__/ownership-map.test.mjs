import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ALL_OWNERS, APP_SCHEMAS, buildOwnershipMap } from '../lib/migration-ownership-parser.mjs';

// #2526 (#1991 phase 1): invariants of the committed ownership artifacts.
// check-migration-ownership.mjs guards *changed* files in a PR; this suite
// guards the committed map itself so it cannot drift or lose an owner.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');
const readJson = (name) => JSON.parse(readFileSync(join(MIGRATIONS, name), 'utf8'));

const ownership = readJson('ownership.json');
const gapsFile = readJson('ownership-gaps.json');
const allowlist = readJson('cross-schema-allowlist.json');

function sourcePath(file) {
  const rootPath = join(ROOT, file);
  if (existsSync(rootPath)) return rootPath;
  // Only exact historical root migration references have an archive fallback.
  // All other missing sources still fail, including unknown archive SQL.
  const historical = /^migrations\/(\d{4}_[^/\\]+\.sql)$/.exec(file);
  return historical
    ? join(MIGRATIONS, 'archive/pre-kernel-baseline', historical[1])
    : rootPath;
}

describe('migrations/ownership.json', () => {
  it('records extracted schema repositories without rewriting table origins', () => {
    for (const schema of ['coffee', 'dykil', 'learn', 'market']) {
      expect(ownership.externalSchemas[schema]).toEqual({
        owner: schema,
        repository: `ima-jin/${schema}`,
      });
    }
    for (const table of ['dykil.surveys', 'dykil.survey_responses']) {
      expect(ownership.tables[table].owner).toBe('dykil');
      expect(ownership.tables[table].firstMigration).toBe('0001_seed.sql');
    }
  });
  it('assigns every table exactly one valid owner, consistent with its schema', () => {
    const schemaOwner = new Map();
    for (const [name, entry] of Object.entries(ownership.tables)) {
      expect(ALL_OWNERS.has(entry.owner), `${name}: unknown owner ${entry.owner}`).toBe(true);
      expect(name.startsWith(`${entry.schema}.`), `${name}: key/schema mismatch`).toBe(true);
      const prior = schemaOwner.get(entry.schema);
      if (prior !== undefined) {
        expect(prior, `schema ${entry.schema} split across owners`).toBe(entry.owner);
      }
      schemaOwner.set(entry.schema, entry.owner);
    }
  });

  it('an app owns a table only in its own schema (schema name == owner)', () => {
    for (const [name, entry] of Object.entries(ownership.tables)) {
      if (APP_SCHEMAS.has(entry.owner)) {
        expect(entry.schema, name).toBe(entry.owner);
      } else {
        expect(APP_SCHEMAS.has(entry.schema), `${name}: app schema owned by ${entry.owner}`).toBe(false);
      }
    }
  });

  it('matches a fresh replay of every migration file (no drift, nothing unmapped)', () => {
    const fresh = buildOwnershipMap(MIGRATIONS);
    const freshTables = [...fresh.values()]
      .filter((e) => e.kind === 'table')
      .map((e) => `${e.schema}.${e.name}`)
      .sort((a, b) => a.localeCompare(b));
    expect(Object.keys(ownership.tables).sort((a, b) => a.localeCompare(b))).toEqual(freshTables);
    for (const e of fresh.values()) {
      if (e.kind !== 'table') continue;
      expect(ownership.tables[`${e.schema}.${e.name}`].owner).toBe(e.owner);
      expect(ownership.tables[`${e.schema}.${e.name}`].firstMigration).toBe(e.firstMigration);
    }
  });

  it('only grandfathers shared migrations that exist on disk', () => {
    for (const file of ownership.sharedMigrationAllowlist) {
      expect(() => readFileSync(sourcePath(`migrations/${file}`), 'utf8'), file).not.toThrow();
    }
  });

  it('retains a real source file for every recorded first migration', () => {
    for (const bucket of ['tables', 'views', 'types', 'functions']) {
      for (const [name, entry] of Object.entries(ownership[bucket])) {
        expect(() => readFileSync(sourcePath(`migrations/${entry.firstMigration}`), 'utf8'), name).not.toThrow();
      }
    }
  });
});

describe('migrations/ownership-gaps.json', () => {
  const gaps = gapsFile.gaps;

  it('has unique ids and every open gap points at a filed issue', () => {
    const ids = gaps.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of gaps.filter((x) => x.status === 'open')) {
      expect(Number.isInteger(g.issue), `${g.id}: open gap needs an issue number`).toBe(true);
    }
  });

  it('references only tables that exist in ownership.json (wildcards allowed)', () => {
    for (const g of gaps) {
      if (g.table.endsWith('*')) continue;
      expect(ownership.tables[g.table], `${g.id}: ${g.table} not in map`).toBeDefined();
      expect(ownership.tables[g.table].owner, `${g.id}: wrong 'to' owner`).toBe(g.to);
    }
  });

  it('open runtime gaps equal the cross-schema allowlist exactly', () => {
    const fromGaps = gaps
      .filter((g) => g.kind === 'runtime' && g.status === 'open')
      .flatMap((g) => g.files.map((f) => `${f}|${g.table}`))
      .sort((a, b) => a.localeCompare(b));
    const fromAllowlist = allowlist.violations
      .map((v) => `${v.file}|${v.schema}.${v.table}`)
      .sort((a, b) => a.localeCompare(b));
    expect(fromGaps).toEqual(fromAllowlist);
  });

  it('cites existing files except frozen history for retired apps/events (#2517)', () => {
    for (const g of gaps) {
      for (const f of g.files) {
        // #1991/#2844 own these historical artifacts. Retiring source is not
        // a reason to rewrite migration history or its recorded audit gaps.
        if (f.startsWith('apps/events/') && !existsSync(join(ROOT, 'apps/events/package.json'))) continue;
        expect(() => readFileSync(sourcePath(f), 'utf8'), `${g.id}: ${f}`).not.toThrow();
      }
    }
  });
});
