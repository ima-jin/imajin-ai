import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('migrations/ownership.json', () => {
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
    }
  });

  it('only grandfathers shared migrations that exist on disk', () => {
    for (const file of ownership.sharedMigrationAllowlist) {
      expect(() => readFileSync(join(MIGRATIONS, file), 'utf8'), file).not.toThrow();
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

  it('cites files that exist', () => {
    for (const g of gaps) {
      for (const f of g.files) {
        expect(() => readFileSync(join(ROOT, f), 'utf8'), `${g.id}: ${f}`).not.toThrow();
      }
    }
  });
});
