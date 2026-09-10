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

// ── stripSqlComments: one small helper per token kind ───────────────────────
//
// Each helper below "consumes" exactly one kind of token starting at index
// `i` and returns where to resume from, so the dispatcher itself stays a
// flat sequence of independent `if`s (no nesting) and each helper is a
// single, easily-verified state machine.

/**
 * Consumes a `'...'` string literal (with `''` as an escaped quote).
 * Returned verbatim by default — never scanned for comments. Pass
 * `blank: true` to return `''` instead of the literal's real contents (used
 * by `migration-schema-scan.mjs`, where a data value like `'market.sale'`
 * would otherwise false-positive as a schema-qualified table reference).
 */
function consumeStringLiteral(sql, i, blank) {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === "'" && sql[j + 1] === "'") {
      j += 2;
      continue;
    }
    if (sql[j] === "'") {
      j += 1;
      break;
    }
    j += 1;
  }
  return { text: blank ? "''" : sql.slice(i, j), next: j };
}

/**
 * Matches a dollar-quote delimiter (`$$` or `$tag$`) starting at `sql[i]`.
 * Returns the full delimiter string, or `null` if `i` isn't one.
 */
function matchDollarQuoteTag(sql, i) {
  if (sql[i] !== '$') return null;
  const closingDollar = sql.indexOf('$', i + 1);
  if (closingDollar === -1) return null;
  const tagBody = sql.slice(i + 1, closingDollar);
  const isValidTag = tagBody === '' || /^[A-Za-z_]\w*$/.test(tagBody);
  return isValidTag ? sql.slice(i, closingDollar + 1) : null;
}

/**
 * Consumes a `$$...$$` / `$tag$...$tag$` dollar-quoted string (e.g. a
 * plpgsql function body). Copied verbatim, unscanned — to the outer SQL
 * lexer this is one opaque string token, exactly like `'...'`, so a `--` or
 * `/* *\/` written inside a function body is never treated as a comment by
 * this preprocessor.
 */
function consumeDollarQuotedString(sql, i, tag) {
  const closeIndex = sql.indexOf(tag, i + tag.length);
  const end = closeIndex === -1 ? sql.length : closeIndex + tag.length;
  return { text: sql.slice(i, end), next: end };
}

/** Consumes a `-- ...` line comment through end-of-line (exclusive). Returns the resume index. */
function consumeLineComment(sql, i) {
  let j = i;
  while (j < sql.length && sql[j] !== '\n') j += 1;
  return j;
}

/** Consumes a `/* ... *\/` block comment. Newlines inside are preserved (as blank text) so line numbers stay accurate. */
function consumeBlockComment(sql, i) {
  let j = i + 2;
  let text = '';
  while (j < sql.length && !(sql[j] === '*' && sql[j + 1] === '/')) {
    if (sql[j] === '\n') text += '\n';
    j += 1;
  }
  return { text, next: Math.min(j + 2, sql.length) };
}

/**
 * Strips `--` line comments and `/* *\/` block comments from SQL text,
 * while passing `'...'` string literals and `$$...$$` dollar-quoted strings
 * through untouched (so a comment marker inside either is never mistaken
 * for a real comment). Newlines are preserved so downstream line-number
 * reporting stays accurate.
 *
 * `{ blankStringLiterals: true }` additionally replaces every `'...'`
 * literal's *contents* with `''` (dollar-quoted bodies are still passed
 * through verbatim either way) — used by `migration-schema-scan.mjs`'s
 * broader schema-reference scan, which must not mistake a dot-namespaced
 * data value for a table reference. Defaults to `false`, so every existing
 * caller (the ownership-map builder and the CI guard) is unaffected.
 */
export function stripSqlComments(sql, { blankStringLiterals = false } = {}) {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === "'") {
      const { text, next } = consumeStringLiteral(sql, i, blankStringLiterals);
      out += text;
      i = next;
      continue;
    }

    const dollarTag = matchDollarQuoteTag(sql, i);
    if (dollarTag) {
      const { text, next } = consumeDollarQuotedString(sql, i, dollarTag);
      out += text;
      i = next;
      continue;
    }

    if (sql[i] === '-' && sql[i + 1] === '-') {
      i = consumeLineComment(sql, i);
      continue;
    }

    if (sql[i] === '/' && sql[i + 1] === '*') {
      const { text, next } = consumeBlockComment(sql, i);
      out += text;
      i = next;
      continue;
    }

    out += sql[i];
    i += 1;
  }

  return out;
}

const NAME = '"?([A-Za-z_][A-Za-z0-9_]*)"?';
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

/** Builds the `${kind}:${schema}.${name}` key an entry is stored under (kind-prefixed so a table and a same-named function never collide). */
function keyFor(kind, schema, name) {
  return `${kind}:${schema}.${name}`;
}

/** Registers a newly-created identity, unless one is already registered under this key (first CREATE wins — matches migration application order). */
function applyCreate(entries, stmt, filename, key) {
  if (entries.has(key)) return;
  entries.set(key, {
    kind: stmt.kind,
    schema: stmt.schema,
    name: stmt.name,
    owner: inferOwnerForSchema(stmt.schema),
    firstMigration: filename,
    notes: '',
  });
}

/** Removes a dropped identity from the map, if it was registered. */
function applyDrop(entries, key) {
  entries.delete(key);
}

/** Moves a renamed identity to its new key, preserving its original `firstMigration`. A no-op if the old name wasn't registered. */
function applyRename(entries, stmt, key) {
  const existing = entries.get(key);
  if (!existing) return;
  const newKey = keyFor(stmt.kind, stmt.schema, stmt.renameTo);
  entries.delete(key);
  entries.set(newKey, { ...existing, name: stmt.renameTo });
}

/** Classifies one parsed statement and applies its effect (create/drop/rename) to `entries`. */
function applyStatement(entries, stmt, filename) {
  const key = keyFor(stmt.kind, stmt.schema, stmt.name);
  if (stmt.action === 'create') return applyCreate(entries, stmt, filename, key);
  if (stmt.action === 'drop') return applyDrop(entries, key);
  if (stmt.action === 'rename') return applyRename(entries, stmt, key);
}

/** Parses one migration file and applies every statement it contains to `entries`, in source order. */
function applyMigrationFile(entries, migrationsDir, filename) {
  const sql = readFileSync(join(migrationsDir, filename), 'utf8');
  for (const stmt of parseStatements(sql)) {
    applyStatement(entries, stmt, filename);
  }
}

/**
 * Build the full ownership map by replaying every migration file in order.
 * Returns a Map keyed by `${kind}:${schema}.${name}` (kind-prefixed so a
 * table and a same-named function never collide).
 */
export function buildOwnershipMap(migrationsDir, files = listMigrationFiles(migrationsDir)) {
  const entries = new Map();

  for (const filename of files) {
    applyMigrationFile(entries, migrationsDir, filename);
  }

  return entries;
}
