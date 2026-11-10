import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { attestations } from '@/src/db/schemas/auth';

const migration = readFileSync(resolve('migrations/0239_unique_unrevoked_app_grant.sql'), 'utf8');
const preflight = readFileSync(resolve('scripts/sql/app-authorization-surplus.sql'), 'utf8');
const indexName = 'uniq_auth_attestations_unrevoked_app_grant';
let db: PGlite;

async function seed(id: string, extra: { revoked?: boolean; expired?: boolean; type?: string; issuer?: string; subject?: string } = {}) {
  await db.query(`
    INSERT INTO auth.attestations (id, issuer_did, subject_did, type, signature, expires_at, revoked_at)
    VALUES ($1, $2, $3, $4, 'retained-signed-history', $5, $6)
  `, [id, extra.issuer ?? 'did:imajin:person', extra.subject ?? 'did:imajin:app',
    extra.type ?? 'app.authorized', extra.expired ? new Date(0) : null, extra.revoked ? new Date(0) : null]);
}

async function surplusCount() {
  const results = await db.exec(preflight);
  return results.flatMap(result => result.rows)[0];
}

async function history() {
  return (await db.query('SELECT * FROM auth.attestations ORDER BY id')).rows;
}

describe('unique unrevoked app grant migration (#3023)', () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.attestations (
        id text PRIMARY KEY, issuer_did text NOT NULL, subject_did text NOT NULL,
        type text NOT NULL, signature text NOT NULL,
        expires_at timestamptz, revoked_at timestamptz
      );
    `);
  });
  afterEach(async () => { await db.close(); });

  it('matches the Drizzle unique index, ordered columns and exact predicate', () => {
    const index = getTableConfig(attestations).indexes.find(entry => entry.config.name === indexName);
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map(column => 'name' in column ? column.name : null))
      .toEqual(['issuer_did', 'subject_did']);
    expect(new PgDialect().sqlToQuery(index!.config.where!).sql)
      .toBe('"auth"."attestations"."type" = \'app.authorized\' AND "auth"."attestations"."revoked_at" IS NULL');
    const statements = migration.replaceAll('\r\n', '\n').replaceAll(/--[^\n]*/g, '').trim();
    expect(statements).toBe(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}
  ON auth.attestations (issuer_did, subject_did)
  WHERE type = 'app.authorized' AND revoked_at IS NULL;`);
  });

  it('preflight returns zero on empty or distinct pairs and leaves history unchanged', async () => {
    expect(await surplusCount()).toEqual({ surplus_count: 0 });
    await seed('person');
    await seed('org', { issuer: 'did:imajin:org' });
    await seed('other-app', { subject: 'did:imajin:other-app' });
    await seed('revoked', { revoked: true });
    await seed('other-type', { type: 'app.revoked' });
    const before = await history();
    expect(await surplusCount()).toEqual({ surplus_count: 0 });
    expect(await history()).toEqual(before);
  });

  it('preflight counts every surplus row including expired, but not revoked or other types', async () => {
    await seed('first');
    await seed('expired', { expired: true });
    await seed('third');
    await seed('revoked', { revoked: true });
    await seed('other-type', { type: 'app.revoked' });
    await seed('org-first', { issuer: 'did:imajin:org' });
    await seed('org-second', { issuer: 'did:imajin:org', expired: true });
    const before = await history();
    expect(await surplusCount()).toEqual({ surplus_count: 3 });
    expect(await history()).toEqual(before);
    await expect(db.exec(migration)).rejects.toMatchObject({ code: '23505' });
    expect(await history()).toEqual(before);
  });

  it('runs twice preserving the same valid index and all signed history', async () => {
    await seed('first');
    await seed('revoked', { revoked: true });
    const before = await history();
    await db.exec(migration);
    const catalog = () => db.query(`
      SELECT indexrelid, indisunique, indisvalid, pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indexrelid = 'auth.${indexName}'::regclass
    `);
    const first = await catalog();
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ indisunique: true, indisvalid: true });
    await db.exec(migration);
    expect((await catalog()).rows).toEqual(first.rows);
    expect(await history()).toEqual(before);
  });

  it.each(['did:imajin:person', 'did:imajin:org'])('refuses a second unrevoked grant for acting principal %s', async issuer => {
    await db.exec(migration);
    await seed('first', { issuer });
    await expect(seed('second', { issuer })).rejects.toMatchObject({ code: '23505', constraint: indexName });
    expect((await history()).map(row => (row as { id: string }).id)).toEqual(['first']);
  });

  it('refuses insertion behind an expired-but-unrevoked grant without mutating history', async () => {
    await seed('expired', { expired: true });
    await db.exec(migration);
    const before = await history();
    await expect(seed('fresh')).rejects.toMatchObject({ code: '23505', constraint: indexName });
    expect(await history()).toEqual(before);
  });

  it('allows revoked history, other attestation types and independently keyed principals/apps', async () => {
    await db.exec(migration);
    await seed('first');
    await seed('revoked', { revoked: true });
    await seed('other-proof', { type: 'app.revoked' });
    await seed('other-proof-again', { type: 'app.revoked' });
    await seed('org', { issuer: 'did:imajin:org' });
    await seed('other-app', { subject: 'did:imajin:other-app' });
    expect(await history()).toHaveLength(6);
    expect(await surplusCount()).toEqual({ surplus_count: 0 });
  });

  it('also refuses an update that would restore a second unrevoked grant', async () => {
    await db.exec(migration);
    await seed('first');
    await seed('revoked', { revoked: true });
    const before = await history();
    await expect(db.query("UPDATE auth.attestations SET revoked_at = NULL WHERE id = 'revoked'"))
      .rejects.toMatchObject({ code: '23505', constraint: indexName });
    expect(await history()).toEqual(before);
  });
});
