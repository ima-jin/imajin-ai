import { describe, it, expect } from 'vitest';
import {
  detectTouchedSchemas,
  detectTouchedOwners,
  classifyMigrationFile,
  maskForSchemaScan,
  KERNEL_SCHEMAS,
  ALL_SCHEMAS,
} from '../lib/migration-schema-scan.mjs';
import { APP_SCHEMAS } from '../lib/migration-ownership-parser.mjs';

describe('detectTouchedSchemas', () => {
  it('finds a schema referenced by a plain CREATE TABLE', () => {
    const schemas = detectTouchedSchemas('CREATE TABLE IF NOT EXISTS links.pages (id INT);');
    expect(schemas).toEqual(new Set(['links']));
  });

  it('finds a schema referenced only by DML (no DDL at all)', () => {
    // This is the exact shape of migrations/0025_backfill_survey_responses_for_orphan_registrations.sql:
    // zero DDL, but a real cross-schema JOIN/UPDATE.
    const sql = `
      UPDATE dykil.survey_responses sr
      SET ticket_id = tr.ticket_id
      FROM events.ticket_registrations tr
      WHERE sr.id = tr.response_id;
    `;
    expect(detectTouchedSchemas(sql)).toEqual(new Set(['dykil', 'events']));
  });

  it('handles double-quoted schema-qualified identifiers', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS "relay"."relay_revocations" (cid text);';
    expect(detectTouchedSchemas(sql)).toEqual(new Set(['relay']));
  });

  it('does not treat a table alias as a schema reference', () => {
    // "tr" and "sr" are aliases, not schemas — must not appear in the result.
    const sql = 'SELECT tr.ticket_id, sr.id FROM events.ticket_registrations tr, dykil.survey_responses sr;';
    const schemas = detectTouchedSchemas(sql);
    expect(schemas).toEqual(new Set(['events', 'dykil']));
    expect(schemas.has('tr')).toBe(false);
    expect(schemas.has('sr')).toBe(false);
  });

  it('does not treat a dot-namespaced string literal value as a schema reference', () => {
    // Regression test: 'market.sale' / 'learn.enrolled' are event_type data
    // values in migrations/0039_seed_bus_chain_configs.sql, not table refs.
    const sql = `INSERT INTO kernel.bus_chain_configs (event_type) VALUES ('market.sale');`;
    expect(detectTouchedSchemas(sql)).toEqual(new Set(['kernel']));
  });

  it('still scans inside a DO $$ ... $$ block (idempotent ALTER guards)', () => {
    const sql = `DO $$ BEGIN ALTER TABLE ONLY links.clicks ADD CONSTRAINT link_clicks_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
    expect(detectTouchedSchemas(sql)).toEqual(new Set(['links']));
  });

  it('ignores a schema-like word inside a -- comment', () => {
    const sql = '-- references dykil.survey_responses for context\nCREATE TABLE IF NOT EXISTS events.real (id INT);';
    expect(detectTouchedSchemas(sql)).toEqual(new Set(['events']));
  });

  it('ignores a schema-like word inside a block comment', () => {
    const sql = '/* auth.identities mentioned here */\nCREATE TABLE IF NOT EXISTS events.real (id INT);';
    expect(detectTouchedSchemas(sql)).toEqual(new Set(['events']));
  });

  it('returns an empty set when nothing schema-qualified is present', () => {
    expect(detectTouchedSchemas('SELECT 1;')).toEqual(new Set());
  });
});

describe('detectTouchedOwners', () => {
  it('maps every app schema to itself and every other schema to kernel', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS links.pages (id INT); CREATE TABLE IF NOT EXISTS auth.identities (id INT);';
    expect(detectTouchedOwners(sql)).toEqual(new Set(['links', 'kernel']));
  });
});

describe('classifyMigrationFile', () => {
  it('classifies a single-schema file as "single"', () => {
    const result = classifyMigrationFile('CREATE TABLE IF NOT EXISTS links.pages (id INT);');
    expect(result).toEqual({ kind: 'single', owner: 'links' });
  });

  it('classifies a multi-owner file as "shared"', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS links.pages (id INT); CREATE TABLE IF NOT EXISTS dykil.surveys (id INT);';
    const result = classifyMigrationFile(sql);
    expect(result.kind).toBe('shared');
    expect(result.owners).toEqual(new Set(['links', 'dykil']));
  });

  it('classifies a file with zero detected schemas as "shared" (conservative default)', () => {
    const result = classifyMigrationFile('SELECT 1;');
    expect(result.kind).toBe('shared');
    expect(result.owners).toEqual(new Set());
  });

  it('classifies the real 0025 cross-owner data migration as shared', () => {
    const sql = `
      UPDATE dykil.survey_responses sr
      SET ticket_id = tr.ticket_id
      FROM events.ticket_registrations tr
      WHERE sr.id = tr.response_id;
    `;
    const result = classifyMigrationFile(sql);
    expect(result.kind).toBe('shared');
    expect(result.owners).toEqual(new Set(['dykil', 'events']));
  });
});

describe('maskForSchemaScan', () => {
  it('blanks single-quoted string literal contents', () => {
    const masked = maskForSchemaScan("INSERT INTO t (label) VALUES ('market.sale');");
    expect(masked).not.toContain('market.sale');
    expect(masked).toContain("''");
  });

  it('preserves dollar-quoted body contents verbatim', () => {
    const masked = maskForSchemaScan('SELECT $$ links.pages $$;');
    expect(masked).toContain('links.pages');
  });

  it('strips -- line comments', () => {
    const masked = maskForSchemaScan('-- auth.identities\nSELECT 1;');
    expect(masked).not.toContain('auth.identities');
  });

  it('strips block comments', () => {
    const masked = maskForSchemaScan('/* auth.identities */\nSELECT 1;');
    expect(masked).not.toContain('auth.identities');
  });
});

describe('shared schema constants', () => {
  it('KERNEL_SCHEMAS and APP_SCHEMAS are disjoint', () => {
    for (const schema of KERNEL_SCHEMAS) {
      expect(APP_SCHEMAS.has(schema)).toBe(false);
    }
  });

  it('ALL_SCHEMAS is the union of APP_SCHEMAS and KERNEL_SCHEMAS', () => {
    expect(ALL_SCHEMAS.size).toBe(APP_SCHEMAS.size + KERNEL_SCHEMAS.size);
    for (const schema of APP_SCHEMAS) expect(ALL_SCHEMAS.has(schema)).toBe(true);
    for (const schema of KERNEL_SCHEMAS) expect(ALL_SCHEMAS.has(schema)).toBe(true);
  });
});
