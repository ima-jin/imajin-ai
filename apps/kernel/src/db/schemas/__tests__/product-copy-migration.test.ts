import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sqlFile = (name: string) => readFileSync(new URL(
  `../../../../../../migrations/${name}`, import.meta.url,
), 'utf8');
const migration = sqlFile('0224_product_copy_issue_refs.sql');
const baseline = sqlFile('0001_kernel_baseline.sql');
const tables = ['registry.apps', 'auth.attestation_type_registry'];
const descriptions = [
  'events (provisioned via apps.provision #2375)',
  'Dynamically registered MCP connector client (#1185, RFC 7591)',
  'Imajin Learn — courses (first-party, #1990)',
  'Claude Desktop — read-only connector (#1166)',
  'Already clean', null, '',
];
const cleanDescriptions = [
  'events', 'Dynamically registered MCP connector client', 'Imajin Learn — courses',
  'Claude Desktop — read-only connector', ...descriptions.slice(4),
];

async function createTables(db: PGlite) {
  await db.exec('CREATE SCHEMA registry; CREATE SCHEMA auth; CREATE SCHEMA kernel;');
  for (const table of tables) {
    const start = baseline.indexOf(`CREATE TABLE ${table} (`);
    expect(start).toBeGreaterThan(-1);
    await db.exec(baseline.slice(start, baseline.indexOf('\n);', start) + 3));
  }
}

async function assertNoLeaks(db: PGlite) {
  // Exactly the operator's post-deploy predicate, against actual PostgreSQL.
  const count = await db.query<{ count: number }>(`
    SELECT count(*)::int AS count FROM registry.apps WHERE description ~ '#[0-9]{3,4}'
  `);
  expect(count.rows).toEqual([{ count: 0 }]);
}

describe('stored product copy repair', () => {
  it('updates all four suffixes on active and revoked rows, preserving every other field and replaying unchanged', async () => {
    const db = new PGlite();
    try {
      await createTables(db);
      await db.exec(`
        CREATE TABLE kernel.loops (summary text);
        INSERT INTO kernel.loops VALUES ('operator history #1234');
        INSERT INTO auth.attestation_type_registry (type_name, description) VALUES
          ('value_realized', 'Only the bilateral form may trigger settlement (#1886).'),
          ('other', 'Unrelated type');
      `);
      for (const status of ['active', 'revoked']) {
        for (const [index, description] of descriptions.entries()) {
          await db.query(`INSERT INTO registry.apps
            (id, owner_did, name, description, app_did, public_key, callback_url, status)
            VALUES ($1, 'did:imajin:owner', 'Fixture', $2, 'did:imajin:app', 'public', 'https://app.test', $3)`,
          [`${status}-${index}`, description, status]);
        }
      }
      const before = (await db.query<{ id: string; description: string | null }>(
        'SELECT * FROM registry.apps ORDER BY id',
      )).rows;
      const typesBefore = (await db.query('SELECT * FROM auth.attestation_type_registry ORDER BY type_name')).rows;
      await db.exec(migration);
      const first = (await db.query('SELECT * FROM registry.apps ORDER BY id')).rows;
      expect(first).toEqual(before.map(row => ({
        ...row, description: cleanDescriptions[Number(row.id.split('-')[1])],
      })));
      await assertNoLeaks(db);
      const typesAfter = (await db.query('SELECT * FROM auth.attestation_type_registry ORDER BY type_name')).rows;
      expect(typesAfter).toEqual(typesBefore.map(row => ({
        ...row,
        description: row.type_name === 'value_realized' ? 'Only the bilateral form may trigger settlement.' : row.description,
      })));
      await db.exec(migration);
      expect((await db.query('SELECT * FROM registry.apps ORDER BY id')).rows).toEqual(first);
      expect((await db.query('SELECT * FROM auth.attestation_type_registry ORDER BY type_name')).rows).toEqual(typesAfter);
      expect((await db.query('SELECT summary FROM kernel.loops')).rows).toEqual([{ summary: 'operator history #1234' }]);
    } finally {
      await db.close();
    }
  });

  it('cleans the unchanged fresh-install baseline seeds with no row-count change', async () => {
    const db = new PGlite();
    try {
      await createTables(db);
      const seeds = baseline.split('\n').filter(line =>
        tables.some(table => line.startsWith(`INSERT INTO ${table} `)));
      expect(seeds.length).toBeGreaterThan(0);
      await db.exec(seeds.join('\n'));
      const before = (await db.query('SELECT * FROM registry.apps')).rows;
      expect(before.some(row => /#\d+/.test(String(row.description)))).toBe(true);
      await db.exec(migration);
      await assertNoLeaks(db);
      const after = (await db.query('SELECT * FROM registry.apps')).rows;
      expect(after.map(({ description: _description, ...row }) => row))
        .toEqual(before.map(({ description: _description, ...row }) => row));
      expect((await db.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM auth.attestation_type_registry WHERE description ~ '#[0-9]{3,4}'
      `)).rows).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('contains only UPDATE statements', () => {
    const statements = migration.replaceAll(/--[^\n]*/g, '').split(';').filter(value => value.trim());
    expect(statements).toHaveLength(2);
    for (const statement of statements) expect(statement.trim()).toMatch(/^UPDATE /);
  });
});
