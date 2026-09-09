#!/usr/bin/env node
/**
 * Backfill migrations/ownership.json from the full migration history (#1991
 * phase 1). One-off/occasional tool — NOT part of the CI guard, which only
 * ever reads ownership.json and parses changed files (see
 * check-migration-ownership.mjs).
 *
 * Run this again only if you deliberately need to regenerate the map from
 * scratch (e.g. after auditing and fixing a bad owner assignment by hand).
 * Routine new tables are added by `check-migration-ownership.mjs`'s
 * auto-register step instead, which only appends — it never touches
 * existing entries.
 *
 * Usage: node scripts/generate-migration-ownership.mjs [--write]
 *   (no flag) prints the generated JSON to stdout for review.
 *   --write   writes migrations/ownership.json.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOwnershipMap } from './lib/migration-ownership-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const OUTPUT_PATH = join(MIGRATIONS_DIR, 'ownership.json');

function toOutputShape(entries) {
  const output = { tables: {}, views: {}, types: {}, functions: {} };
  const bucketFor = { table: 'tables', view: 'views', type: 'types', function: 'functions' };

  const sortedEntries = [...entries.values()].sort((a, b) => {
    if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
    return a.name.localeCompare(b.name);
  });

  for (const entry of sortedEntries) {
    const bucket = output[bucketFor[entry.kind]];
    bucket[`${entry.schema}.${entry.name}`] = {
      owner: entry.owner,
      schema: entry.schema,
      firstMigration: entry.firstMigration,
      notes: entry.notes,
    };
  }

  return output;
}

const entries = buildOwnershipMap(MIGRATIONS_DIR);
const output = toOutputShape(entries);
const json = `${JSON.stringify(output, null, 2)}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(OUTPUT_PATH, json, 'utf8');
  console.log(`Wrote ${Object.keys(output.tables).length} table(s), ${Object.keys(output.functions).length} function(s) to ${OUTPUT_PATH}`);
} else {
  process.stdout.write(json);
}
