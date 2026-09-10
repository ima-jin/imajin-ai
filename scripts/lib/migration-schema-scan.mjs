/**
 * Schema-reference scanning for migrations (#1991 phase 2a).
 *
 * `migration-ownership-parser.mjs`'s `parseStatements` only recognizes DDL
 * forms (`CREATE`/`ALTER`/`DROP TABLE`, `CREATE VIEW`/`TYPE`/`FUNCTION`) —
 * enough to build the ownership map, since that's the only DDL this repo's
 * migrations use. It does NOT see plain DML (`INSERT`/`UPDATE`/`SELECT` ...
 * `FROM`/`JOIN` a schema-qualified table), which several existing
 * migrations use to read or write another owner's tables directly (see
 * `migrations/0025_backfill_survey_responses_for_orphan_registrations.sql`
 * and `0026_clone_shared_survey_responses_per_ticket.sql`, both `dykil`
 * migrations that `JOIN`/`UPDATE` `events.*` tables with zero DDL at all).
 *
 * This module answers a different question than the parser: "every schema
 * this file's SQL text references anywhere, DDL or DML" — needed so
 * `migrate.mjs --owner <app>` and the CI guard's shared-migration check can
 * tell whether a file is safe to run/allow in isolation for one owner, or
 * whether it's genuinely shared (touches more than one owner's schema).
 *
 * ## Method
 *
 * Regex-scan the file for `<schema>.<identifier>` (optionally
 * double-quoted, e.g. `"auth"."identities"`) where `<schema>` is one of
 * this repo's known schema names (`migrations/OWNERSHIP.md`'s Owners
 * table). Comments are stripped first (reusing the same rules as
 * `stripSqlComments`); unlike that function, single-quoted string literal
 * *contents* are also blanked here (not preserved) — otherwise a data
 * value like `'market.sale'` (an event_type string in
 * `0039_seed_bus_chain_configs.sql`, dot-namespaced but not a table
 * reference) would false-positive as a reference to the `market` schema.
 * `$$...$$` dollar-quoted bodies (e.g. a `DO $$ ... $$` idempotency guard)
 * are still scanned, since those routinely contain real schema-qualified
 * DDL/DML (see `0001_seed.sql`'s `DO $$ BEGIN ALTER TABLE ONLY links.clicks
 * ADD CONSTRAINT ...`).
 *
 * This is a heuristic, not a SQL parser: it does not distinguish a genuine
 * schema-qualified reference from a coincidental `word.word` sequence, but
 * false positives from that are unlikely given how distinctive this repo's
 * schema names are (see `ALL_SCHEMAS` below), and any regression is
 * caught by `scripts/__tests__/migration-schema-scan.test.mjs`.
 */

import { APP_SCHEMAS, inferOwnerForSchema, stripSqlComments } from './migration-ownership-parser.mjs';

/**
 * Every schema that belongs to the kernel monolith (see
 * `migrations/OWNERSHIP.md`'s Owners table) — the complement of
 * `APP_SCHEMAS`, listed explicitly (rather than treating every
 * non-app-schema string as a kernel schema) so this scanner's regex only
 * matches real schema names and not two-part table aliases like `tr.id`
 * or `sr.ticket_id`, which are common in this repo's DML migrations.
 */
export const KERNEL_SCHEMAS = new Set([
  'auth',
  'chat',
  'connections',
  'consent_requests',
  'github',
  'inference',
  'kernel',
  'media',
  'money',
  'notify',
  'operator',
  'pay',
  'profile',
  'registry',
  'relay',
  'usage',
  'www',
]);

/** Every schema name this scanner will recognize — app schemas plus kernel schemas. */
export const ALL_SCHEMAS = new Set([...APP_SCHEMAS, ...KERNEL_SCHEMAS]);

const SCHEMA_ALTERNATION = [...ALL_SCHEMAS].join('|');
// Group 1: the character before the match (or start-of-string), kept out of
// the schema name itself so e.g. "mykernel.foo" doesn't match "kernel".
// Group 2: the schema name. Quotes around it are optional and not captured.
const SCHEMA_REF_RE = new RegExp(String.raw`(^|[^A-Za-z0-9_])"?(${SCHEMA_ALTERNATION})"?\.`, 'gi');

/**
 * Strips `--`/`/* *\/` comments and blanks single-quoted string literal
 * contents, while passing `$$...$$` dollar-quoted bodies through verbatim
 * — a thin wrapper over the shared
 * `stripSqlComments(sql, { blankStringLiterals: true })`. Exported for
 * testing; `detectTouchedSchemas`/`detectTouchedOwners` are the intended
 * public entry points.
 */
export function maskForSchemaScan(sql) {
  return stripSqlComments(sql, { blankStringLiterals: true });
}

/** Every distinct schema name (lowercased) referenced anywhere in `sql`, DDL or DML. */
export function detectTouchedSchemas(sql) {
  const masked = maskForSchemaScan(sql);
  const schemas = new Set();
  SCHEMA_REF_RE.lastIndex = 0;
  let match = SCHEMA_REF_RE.exec(masked);
  while (match !== null) {
    schemas.add(match[2].toLowerCase());
    match = SCHEMA_REF_RE.exec(masked);
  }
  return schemas;
}

/** Every distinct owner (app name or `kernel`) whose schema is referenced anywhere in `sql`. */
export function detectTouchedOwners(sql) {
  return new Set([...detectTouchedSchemas(sql)].map(inferOwnerForSchema));
}

/**
 * Classifies a migration file's SQL against the owners it touches:
 *   - exactly one owner  → `{ kind: 'single', owner }`
 *   - zero or 2+ owners  → `{ kind: 'shared', owners }` (a file with zero
 *     detected owners is treated as shared too — the conservative default,
 *     so an unrecognized reference never gets silently and wrongly scoped
 *     to a single owner's run).
 */
export function classifyMigrationFile(sql) {
  const owners = detectTouchedOwners(sql);
  if (owners.size === 1) {
    return { kind: 'single', owner: [...owners][0] };
  }
  return { kind: 'shared', owners };
}
