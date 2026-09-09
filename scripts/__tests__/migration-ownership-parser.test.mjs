import { describe, it, expect } from 'vitest';
import {
  parseStatements,
  stripSqlComments,
  inferOwnerForSchema,
  ALL_OWNERS,
  APP_SCHEMAS,
  BUCKET_FOR_KIND,
} from '../lib/migration-ownership-parser.mjs';

describe('parseStatements', () => {
  it('parses a schema-qualified CREATE TABLE', () => {
    const [stmt] = parseStatements('CREATE TABLE IF NOT EXISTS auth.identities (did TEXT PRIMARY KEY);');
    expect(stmt).toMatchObject({ kind: 'table', action: 'create', schema: 'auth', name: 'identities' });
  });

  it('defaults to the public schema for an unqualified CREATE TABLE', () => {
    const [stmt] = parseStatements('CREATE TABLE widgets (id SERIAL PRIMARY KEY);');
    expect(stmt).toMatchObject({ kind: 'table', action: 'create', schema: 'public', name: 'widgets' });
  });

  it('skips CREATE TEMP TABLE (not a persistent identity)', () => {
    const statements = parseStatements('CREATE TEMP TABLE scratch AS SELECT 1;');
    expect(statements).toHaveLength(0);
  });

  it('parses DROP TABLE', () => {
    const [stmt] = parseStatements('DROP TABLE IF EXISTS events.ticket_registrations CASCADE;');
    expect(stmt).toMatchObject({ kind: 'table', action: 'drop', schema: 'events', name: 'ticket_registrations' });
  });

  it('parses ALTER TABLE ... RENAME TO with the target name', () => {
    const [stmt] = parseStatements('ALTER TABLE coffee.old_name RENAME TO new_name;');
    expect(stmt).toMatchObject({
      kind: 'table',
      action: 'rename',
      schema: 'coffee',
      name: 'old_name',
      renameTo: 'new_name',
    });
  });

  it('also registers a generic ALTER TABLE (e.g. ADD COLUMN) as touching the table', () => {
    const statements = parseStatements('ALTER TABLE auth.identities ADD COLUMN foo TEXT;');
    expect(statements.some((s) => s.action === 'alter' && s.schema === 'auth' && s.name === 'identities')).toBe(
      true,
    );
  });

  it('parses CREATE VIEW', () => {
    const [stmt] = parseStatements('CREATE VIEW reporting.summary AS SELECT 1;');
    expect(stmt).toMatchObject({ kind: 'view', action: 'create', schema: 'reporting', name: 'summary' });
  });

  it('parses CREATE VIEW IF NOT EXISTS without swallowing "IF" as the name', () => {
    const [stmt] = parseStatements('CREATE VIEW IF NOT EXISTS reporting.summary AS SELECT 1;');
    expect(stmt).toMatchObject({ kind: 'view', action: 'create', schema: 'reporting', name: 'summary' });
    expect(stmt.name).not.toBe('IF');
  });

  it('parses CREATE OR REPLACE VIEW', () => {
    const [stmt] = parseStatements('CREATE OR REPLACE VIEW reporting.summary AS SELECT 1;');
    expect(stmt).toMatchObject({ kind: 'view', action: 'create', schema: 'reporting', name: 'summary' });
  });

  it('parses CREATE TYPE', () => {
    const [stmt] = parseStatements("CREATE TYPE public.mood AS ENUM ('happy', 'sad');");
    expect(stmt).toMatchObject({ kind: 'type', action: 'create', schema: 'public', name: 'mood' });
  });

  it('parses CREATE OR REPLACE FUNCTION', () => {
    const [stmt] = parseStatements(
      'CREATE OR REPLACE FUNCTION registry.cleanup_old_logs(p_days INT DEFAULT 30) RETURNS INT LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;',
    );
    expect(stmt).toMatchObject({ kind: 'function', action: 'create', schema: 'registry', name: 'cleanup_old_logs' });
  });

  it('ignores statements inside -- line comments', () => {
    const statements = parseStatements('-- CREATE TABLE auth.fake (id INT);\nCREATE TABLE events.real (id INT);');
    expect(statements).toHaveLength(1);
    expect(statements[0].name).toBe('real');
  });

  it('ignores statements inside block comments', () => {
    const statements = parseStatements('/* CREATE TABLE auth.fake (id INT); */\nCREATE TABLE events.real (id INT);');
    expect(statements).toHaveLength(1);
    expect(statements[0].name).toBe('real');
  });
});

describe('stripSqlComments', () => {
  it('does not treat "--" inside a string literal as a comment', () => {
    const cleaned = stripSqlComments("INSERT INTO t (label) VALUES ('a--b');\nCREATE TABLE events.real (id INT);");
    expect(cleaned).toContain("'a--b'");
    expect(cleaned).toContain('CREATE TABLE events.real');
  });
});

describe('inferOwnerForSchema', () => {
  it('maps an app schema to itself', () => {
    for (const schema of APP_SCHEMAS) {
      expect(inferOwnerForSchema(schema)).toBe(schema);
    }
  });

  it('maps every other schema to kernel', () => {
    expect(inferOwnerForSchema('auth')).toBe('kernel');
    expect(inferOwnerForSchema('public')).toBe('kernel');
  });
});

describe('shared constants', () => {
  it('ALL_OWNERS includes every app schema plus kernel/broker-agent/corpus', () => {
    for (const schema of APP_SCHEMAS) expect(ALL_OWNERS.has(schema)).toBe(true);
    expect(ALL_OWNERS.has('kernel')).toBe(true);
    expect(ALL_OWNERS.has('broker-agent')).toBe(true);
    expect(ALL_OWNERS.has('corpus')).toBe(true);
  });

  it('BUCKET_FOR_KIND covers every statement kind parseStatements can produce', () => {
    expect(BUCKET_FOR_KIND).toMatchObject({
      table: 'tables',
      view: 'views',
      type: 'types',
      function: 'functions',
    });
  });
});
