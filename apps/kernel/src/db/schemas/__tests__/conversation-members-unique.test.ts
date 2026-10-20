import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
import { conversationMembers } from '../chat-v2';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const migration = readFileSync(join(root, 'migrations/archive/pre-kernel-baseline/0216_restore_conversation_members_unique.sql'), 'utf8');
const indexes = getTableConfig(conversationMembers).indexes
  .filter(({ config }) => config.unique && !config.where)
  .map(({ config }) => config.columns.map(column => column.name).sort());

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

function assertTarget(columns: string[], location: string) {
  expect(indexes, `Missing conversation_members unique index for ${location}: ${columns}`)
    .toContainEqual([...columns].sort());
}

function memberInsert(node: ts.Node, aliases: Set<string>): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (node.expression.name.text === 'insert') {
      return node.arguments.length === 1 && aliases.has(node.arguments[0].getText());
    }
    return memberInsert(node.expression.expression, aliases);
  }
  return false;
}

function checkDrizzle(node: ts.CallExpression, aliases: Set<string>, location: string) {
  if (!ts.isPropertyAccessExpression(node.expression)
    || !['onConflictDoNothing', 'onConflictDoUpdate'].includes(node.expression.name.text)
    || !memberInsert(node.expression.expression, aliases)) return;
  const config = node.arguments[0];
  // Targetless DO NOTHING is legal PostgreSQL; the named membership index is
  // asserted separately so these inserts cannot silently lose deduplication.
  if (!config) return;
  expect(ts.isObjectLiteralExpression(config), location).toBe(true);
  if (!ts.isObjectLiteralExpression(config)) return;
  const target = config.properties.find(property =>
    ts.isPropertyAssignment(property) && property.name.getText() === 'target');
  if (!target || !ts.isPropertyAssignment(target)) return;
  const columns = ts.isArrayLiteralExpression(target.initializer)
    ? target.initializer.elements : [target.initializer];
  assertTarget(columns.map(column => {
    expect(ts.isPropertyAccessExpression(column), location).toBe(true);
    if (!ts.isPropertyAccessExpression(column)) return '<unresolved>';
    expect(aliases.has(column.expression.getText()), location).toBe(true);
    const property = column.name.text as keyof typeof conversationMembers;
    const value = conversationMembers[property];
    return typeof value === 'object' && value !== null && 'name' in value ? String(value.name) : '<unresolved>';
  }), location);
}

describe('conversation_members conflict-target schema guard (#2865)', () => {
  it.each(['onConflictDoNothing', 'onConflictDoUpdate'])('validates %s targets rather than just the method name', method => {
    const check = (target: string) => {
      const source = ts.createSourceFile('fixture.ts',
        `db.insert(members).values({}).${method}({ target: ${target}, set: {} })`,
        ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) checkDrizzle(node, new Set(['members']), 'fixture');
        ts.forEachChild(node, visit);
      };
      visit(source);
    };
    expect(() => check('[members.memberDid, members.conversationDid]')).not.toThrow();
    expect(() => check('[members.memberDid, members.role]')).toThrow('Missing conversation_members unique index');
    expect(() => check('members.memberDid')).toThrow('Missing conversation_members unique index');
  });
  it('keeps the named, non-partial unique index in Drizzle for fresh installs and the baseline squash', () => {
    const index = getTableConfig(conversationMembers).indexes.find(({ config }) => config.name === 'idx_conv_members_unique');
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeUndefined();
    assertTarget(['conversation_did', 'member_did'], 'schema');
  });

  it('backs every kernel Drizzle and raw-SQL membership conflict target with a schema unique index', () => {
    let rawTargets = 0;
    for (const path of sourceFiles(join(root, 'apps/kernel'))) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const aliases = new Set(['conversationMembers']);
      source.forEachChild(node => {
        if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings
          || !ts.isNamedImports(node.importClause.namedBindings)) return;
        for (const element of node.importClause.namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === 'conversationMembers') aliases.add(element.name.text);
        }
      });
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) checkDrizzle(node, aliases, path);
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
          const sql = node.getText();
          for (const match of sql.matchAll(/INSERT\s+INTO\s+chat\.conversation_members\b[^;]*?ON\s+CONFLICT\s*\(([^)]+)\)/gi)) {
            rawTargets++;
            assertTarget(match[1].split(',').map(column => column.trim().replaceAll('"', '')), path);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(rawTargets).toBeGreaterThanOrEqual(7);
  });
});

describe('0216 membership index replay', () => {
  it('repairs missing uniqueness transactionally, then preserves the index on repeat application', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE SCHEMA chat;
        CREATE TABLE chat.conversation_members (id serial PRIMARY KEY, conversation_did text NOT NULL, member_did text NOT NULL);
        INSERT INTO chat.conversation_members (conversation_did, member_did) VALUES ('conversation', 'member');`);
      await db.transaction(tx => tx.exec(migration));
      const before = await db.query("SELECT oid FROM pg_class WHERE relname = 'idx_conv_members_unique'");
      await db.transaction(tx => tx.exec(migration));
      expect(await db.query("SELECT oid FROM pg_class WHERE relname = 'idx_conv_members_unique'")).toEqual(before);
      await db.exec(`INSERT INTO chat.conversation_members (conversation_did, member_did)
        VALUES ('conversation', 'member') ON CONFLICT (conversation_did, member_did) DO NOTHING;
        INSERT INTO chat.conversation_members (conversation_did, member_did)
        VALUES ('conversation', 'member') ON CONFLICT (conversation_did, member_did) DO UPDATE SET member_did = EXCLUDED.member_did;`);
      expect((await db.query('SELECT count(*)::integer AS count FROM chat.conversation_members')).rows).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('refuses duplicates without deleting data or leaving a partial index', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE SCHEMA chat;
        CREATE TABLE chat.conversation_members (conversation_did text, member_did text);
        INSERT INTO chat.conversation_members VALUES ('conversation', 'member'), ('conversation', 'member');`);
      await expect(db.transaction(tx => tx.exec(migration))).rejects.toThrow('could not create unique index');
      expect((await db.query('SELECT count(*)::integer AS count FROM chat.conversation_members')).rows).toEqual([{ count: 2 }]);
      expect((await db.query("SELECT to_regclass('chat.idx_conv_members_unique') AS index")).rows).toEqual([{ index: null }]);
    } finally {
      await db.close();
    }
  });
});
