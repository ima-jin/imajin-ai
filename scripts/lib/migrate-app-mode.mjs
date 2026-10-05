/**
 * Per-app migration mode for `scripts/migrate.mjs` (#1991 phase 2b, #2524).
 *
 *   node scripts/migrate.mjs --app-dir <dir> --schema <schema>
 *
 * An extracted app (e.g. `links`) keeps its own `*.sql` migrations in its own
 * repo and applies them with this runner against its own schema. Unlike the
 * `--owner` filter (phase 2a), which slices the kernel's shared `migrations/`
 * folder and records into the shared `public._migrations`, app mode:
 *
 *   - reads migrations from `--app-dir` (resolved against the cwd), never
 *     from the kernel's `migrations/` folder;
 *   - tracks applied files in `<schema>._migrations` — a ledger inside the
 *     app's own schema, so it never collides with the kernel ledger;
 *   - runs every migration with `search_path` pinned to `<schema>`, so an
 *     unqualified name can only ever land in the app's schema;
 *   - refuses (fails loud, before touching the database) to target a kernel
 *     schema or `public`, and refuses any migration file that references
 *     another known schema (kernel or app) — "an app owner must never run
 *     against the kernel schema".
 *
 * The logic lives here, with the Postgres client injected, so it is testable
 * without a database connection (`migrate.mjs` opens one at import time).
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_SCHEMAS, KERNEL_SCHEMAS, detectTouchedSchemas } from './migration-schema-scan.mjs';
import { mapSequentially } from './sequential.mjs';
import { parseArgs } from './migrate-owner-filter.mjs';

/** Name of the ledger table created inside the app's own schema. */
export const LEDGER_TABLE = '_migrations';

const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED_SCHEMAS = new Set(['public', 'information_schema']);

/** Thrown when an app-mode run would cross a schema boundary. */
export class SchemaMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

const APP_FLAGS = ['--app-dir', '--schema'];

/**
 * Parses the full `migrate.mjs` argv: the phase-2a flags (`--owner`,
 * `--include-shared`, via `parseArgs`) plus the app-mode flags
 * `--app-dir <dir>` and `--schema <name>` (also `--flag=value`). The two
 * app flags must be given together and cannot be combined with `--owner` /
 * `--include-shared`. Returns `{ owner, includeShared, appDir, schema }`;
 * `appDir`/`schema` are `null` outside app mode.
 */
export function parseRunnerArgs(argv) {
  const appValues = { '--app-dir': null, '--schema': null };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = APP_FLAGS.find(f => arg === f || arg.startsWith(`${f}=`));
    if (!flag) {
      rest.push(arg);
    } else if (arg === flag) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value.`);
      }
      appValues[flag] = value;
      i += 1;
    } else {
      appValues[flag] = arg.slice(flag.length + 1);
    }
  }

  const parsed = parseArgs(rest);
  const appDir = appValues['--app-dir'];
  const schema = appValues['--schema'];

  if (appDir === null && schema === null) {
    return { ...parsed, appDir: null, schema: null };
  }
  if (appDir === null || schema === null) {
    throw new Error('--app-dir and --schema must be given together (per-app mode).');
  }
  if (appDir === '' || schema === '') {
    throw new Error('--app-dir and --schema must not be empty.');
  }
  if (parsed.owner !== null) {
    throw new Error('--owner/--include-shared cannot be combined with --app-dir/--schema.');
  }
  assertAppSchema(schema);
  return { ...parsed, appDir, schema };
}

/**
 * Validates the `--schema` target for app mode and returns it. Throws a
 * `SchemaMismatchError` for kernel/reserved schemas and a plain `Error` for
 * a malformed name. The strict identifier pattern also makes the name safe to
 * quote into SQL.
 */
export function assertAppSchema(schema) {
  if (typeof schema !== 'string' || !SCHEMA_NAME_RE.test(schema)) {
    throw new Error(`invalid --schema "${schema}": must match ${SCHEMA_NAME_RE}.`);
  }
  if (KERNEL_SCHEMAS.has(schema)) {
    throw new SchemaMismatchError(
      `--schema "${schema}" is a kernel-owned schema; app migrations must never run against it.`,
    );
  }
  if (RESERVED_SCHEMAS.has(schema) || schema.startsWith('pg_')) {
    throw new SchemaMismatchError(`--schema "${schema}" is a reserved Postgres schema.`);
  }
  return schema;
}

/**
 * Fails loud if `content` references any known schema (kernel or app) other
 * than `schema`. Comments and string literals are ignored by the scanner.
 */
export function assertFileStaysInSchema(filename, content, schema) {
  const foreign = [...detectTouchedSchemas(content)].filter(s => ALL_SCHEMAS.has(s) && s !== schema);
  if (foreign.length > 0) {
    throw new SchemaMismatchError(
      `${filename} references schema(s) ${foreign.sort((a, b) => a.localeCompare(b)).join(', ')} ` +
        `outside the app's own schema "${schema}"; app migrations may only touch their own schema.`,
    );
  }
}

/** Lists `*.sql` files in `dir`, sorted by name. Throws if `dir` is not a directory. */
export function listAppMigrations(dir) {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`--app-dir "${dir}" is not a directory.`);
  }
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Applies pending migrations from `dir` into `schema`.
 *
 * Every file is validated against the schema boundary *before* anything is
 * applied, so a mismatch never leaves the app half-migrated. Applied files
 * are tracked by filename + checksum in `<schema>._migrations`; re-running is
 * a no-op, and a changed checksum warns and skips (same as the kernel runner).
 *
 * @param {object} opts
 * @param {Function} opts.sql    postgres.js client (tagged template, identifier helper, `.begin`)
 * @param {string}   opts.dir    app migrations directory
 * @param {string}   opts.schema target schema (validated here)
 * @param {{log: Function, warn: Function}} [opts.logger]
 * @returns {Promise<number>} number of migrations applied
 */
export async function runAppMigrations({ sql, dir, schema, logger = console }) {
  assertAppSchema(schema);
  const absDir = resolve(dir);
  const files = listAppMigrations(absDir);

  const contents = new Map(files.map(f => [f, readFileSync(resolve(absDir, f), 'utf-8')]));
  contents.forEach((content, filename) => assertFileStaysInSchema(filename, content, schema));

  const ledger = `${schema}.${LEDGER_TABLE}`;
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(schema)}`;
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(ledger)} (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  const rows = await sql`SELECT filename, checksum FROM ${sql(ledger)}`;
  const applied = new Map(rows.map(r => [r.filename, r.checksum]));

  let ranCount = 0;
  // Sequential on purpose: migrations apply in filename order, each in its own transaction.
  await mapSequentially(files, async filename => {
    const content = contents.get(filename);
    const hash = checksum(content);

    if (applied.has(filename)) {
      if (applied.get(filename) === hash) {
        logger.log(`⏭  ${filename} — already applied`);
      } else {
        logger.warn(`⚠️  ${filename} — checksum changed (skipping, DDL is idempotent)`);
      }
      return;
    }

    logger.log(`▶  ${filename} — applying to schema "${schema}"...`);
    await sql.begin(async tx => {
      await tx`SELECT set_config('search_path', ${schema}, true)`;
      await tx.unsafe(content);
      await tx`INSERT INTO ${tx(ledger)} (filename, checksum) VALUES (${filename}, ${hash})`;
    });
    logger.log(`✅ ${filename}`);
    ranCount++;
  });

  logger.log(
    ranCount === 0
      ? `✅ All "${schema}" migrations already applied.`
      : `✅ Applied ${ranCount} "${schema}" migration(s).`,
  );
  return ranCount;
}
