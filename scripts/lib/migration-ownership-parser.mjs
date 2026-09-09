/**
 * Shared SQL parsing for migration ownership (#1991 phase 1).
 *
 * Used by both `scripts/generate-migration-ownership.mjs` (one-off backfill
 * of migrations/ownership.json from the full migration history) and
 * `scripts/check-migration-ownership.mjs` (the CI guard, which only parses
 * changed/added files). Kept in one place so the guard can never drift from
 * how the map itself was derived.
 *
 * Scope: this repo's migrations only ever use `CREATE TABLE`, `DROP TABLE`,
 * `ALTER TABLE ... RENAME TO`, generic `ALTER TABLE` (e.g. `ADD COLUMN`), and
 * `CREATE [OR REPLACE] FUNCTION` (verified by grepping the full migrations/
 * directory — no `CREATE VIEW`, `CREATE TYPE ... AS ENUM`, or `CREATE
 * MATERIALIZED VIEW` exist today). VIEW/TYPE are still parsed below so a
 * future migration that introduces one is registered and ownership-checked
 * rather than silently ignored.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Schemas that map 1:1 onto an app that owns tables in this repo today. */
export const APP_SCHEMAS = new Set(['coffee', 'dykil', 'events', 'learn', 'links', 'market']);

/**
 * Owners that don't correspond to an app schema: the kernel monolith itself,
 * plus broker-agent/corpus, which own zero tables in `migrations/` today
 * (see migrations/OWNERSHIP.md's Gaps section) but are still valid owner
 * names an app could declare.
 */
export const NON_SCHEMA_OWNERS = new Set(['kernel', 'broker-agent', 'corpus']);

/** Every valid owner name — single source of truth shared by the guard and the map generator. */
export const ALL_OWNERS = new Set([...NON_SCHEMA_OWNERS, ...APP_SCHEMAS]);

/** Maps a parsed statement's `kind` to its bucket name in ownership.json. */
export const BUCKET_FOR_KIND = { table: 'tables', view: 'views', type: 'types', function: 'functions' };

/**
 * Every other schema (auth, chat, connections, consent_requests, github,
 * inference, kernel, media, money, notify, operator, pay, profile,
 * registry, relay, usage, www, and unqualified/public) is part of the
 * kernel monolith: no other app in this repo owns a Postgres schema of its
 * own (broker-agent and corpus have zero Postgres/migrations footprint —
 * see migrations/OWNERSHIP.md's Gaps section).
 */
export function inferOwnerForSchema(schema) {
  if (APP_SCHEMAS.has(schema)) return schema;
  return 'kernel';
}

/**
 * Strip `--` line comments and block comments from SQL text while tracking
 * single-quoted string state, so a comment marker inside a string literal
 * (e.g. a default value) is never mistaken for a real comment. Newlines are
 * preserved so downstream line-number reporting stays accurate.
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inString) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") inString = false;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const NAME = String.raw`"?([A-Za-z_][A-Za-z0-9_]*)"?`;
const QUALIFIED = String.raw`${NAME}(?:\.${NAME})?`;
const OPTIONAL_IF_NOT_EXISTS = String.raw`(?:IF\s+NOT\s+EXISTS\s+)?`;
const OPTIONAL_IF_EXISTS = String.raw`(?:IF\s+EXISTS\s+)?`;

// Statement kinds recognized anywhere in migrations/, in the order they're
// matched (order doesn't affect results — matches are re-sorted by source
// position below). Every regex source is built with String.raw so the `\s`/
// `\.` escapes stay single-backslash instead of doubled JS-string escapes.
const STATEMENT_PATTERNS = [
  {
    kind: 'table',
    action: 'create',
    // Group 1 = TEMP/TEMPORARY marker (skip if present — not a persistent table).
    re: new RegExp(String.raw`CREATE\s+(TEMP(?:ORARY)?\s+)?TABLE\s+${OPTIONAL_IF_NOT_EXISTS}${QUALIFIED}`, 'gi'),
    skip: (m) => Boolean(m[1]),
    nameGroups: [2, 3],
  },
  {
    kind: 'table',
    action: 'drop',
    re: new RegExp(String.raw`DROP\s+TABLE\s+${OPTIONAL_IF_EXISTS}${QUALIFIED}`, 'gi'),
    nameGroups: [1, 2],
  },
  {
    kind: 'table',
    action: 'rename',
    re: new RegExp(String.raw`ALTER\s+TABLE\s+${OPTIONAL_IF_EXISTS}${QUALIFIED}\s+RENAME\s+TO\s+${NAME}`, 'gi'),
    nameGroups: [1, 2],
    renameToGroup: 3,
  },
  {
    // Generic ALTER TABLE detector — a superset of the RENAME pattern above,
    // so a plain ALTER (e.g. ADD COLUMN) also registers as "touching" the
    // table. Both patterns matching the same RENAME statement is expected;
    // consumers that care (the CI guard) dedupe by identity and prefer the
    // more specific 'rename' action.
    kind: 'table',
    action: 'alter',
    re: new RegExp(String.raw`ALTER\s+TABLE\s+${OPTIONAL_IF_EXISTS}${QUALIFIED}`, 'gi'),
    nameGroups: [1, 2],
  },
  {
    kind: 'view',
    action: 'create',
    re: new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+${OPTIONAL_IF_NOT_EXISTS}${QUALIFIED}`, 'gi'),
    nameGroups: [1, 2],
  },
  {
    kind: 'type',
    action: 'create',
    re: new RegExp(String.raw`CREATE\s+TYPE\s+${QUALIFIED}`, 'gi'),
    nameGroups: [1, 2],
  },
  {
    kind: 'function',
    action: 'create',
    re: new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QUALIFIED}\s*\(`, 'gi'),
    nameGroups: [1, 2],
  },
];

function resolveQualifiedName(match, nameGroups) {
  const [firstGroup, secondGroup] = nameGroups;
  const first = match[firstGroup];
  const second = match[secondGroup];
  if (second) {
    return { schema: first, name: second };
  }
  return { schema: 'public', name: first };
}

/**
 * Parse a single migration file's SQL text into an ordered list of
 * statements: `{ kind, action, schema, name, renameTo? }`.
 */
export function parseStatements(sql) {
  const cleaned = stripSqlComments(sql);
  const statements = [];

  for (const pattern of STATEMENT_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match = pattern.re.exec(cleaned);
    while (match !== null) {
      if (!pattern.skip?.(match)) {
        const { schema, name } = resolveQualifiedName(match, pattern.nameGroups);
        const statement = { kind: pattern.kind, action: pattern.action, schema, name, index: match.index };
        if (pattern.renameToGroup) {
          statement.renameTo = match[pattern.renameToGroup];
        }
        statements.push(statement);
      }
      match = pattern.re.exec(cleaned);
    }
  }

  statements.sort((a, b) => a.index - b.index);
  return statements;
}

/** List migration filenames in `dir`, sorted the same way migrate.mjs applies them. */
export function listMigrationFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Build the full ownership map by replaying every migration file in order.
 * Returns a Map keyed by `${kind}:${schema}.${name}` (kind-prefixed so a
 * table and a same-named function never collide).
 */
export function buildOwnershipMap(migrationsDir, files = listMigrationFiles(migrationsDir)) {
  const entries = new Map();

  const keyFor = (kind, schema, name) => `${kind}:${schema}.${name}`;

  for (const filename of files) {
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    const statements = parseStatements(sql);

    for (const stmt of statements) {
      const key = keyFor(stmt.kind, stmt.schema, stmt.name);

      if (stmt.action === 'create') {
        if (!entries.has(key)) {
          entries.set(key, {
            kind: stmt.kind,
            schema: stmt.schema,
            name: stmt.name,
            owner: inferOwnerForSchema(stmt.schema),
            firstMigration: filename,
            notes: '',
          });
        }
        continue;
      }

      if (stmt.action === 'drop') {
        entries.delete(key);
        continue;
      }

      if (stmt.action === 'rename') {
        const existing = entries.get(key);
        if (existing) {
          const newKey = keyFor(stmt.kind, stmt.schema, stmt.renameTo);
          entries.delete(key);
          entries.set(newKey, { ...existing, name: stmt.renameTo });
        }
      }
    }
  }

  return entries;
}
