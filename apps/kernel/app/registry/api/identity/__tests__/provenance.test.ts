import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

const h = vi.hoisted(() => ({ db: null as unknown, appDid: null as string | null }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/identity-aliases'),
  get db() { return h.db; },
}));
vi.mock('@imajin/auth', () => ({
  requireAppAuth: async () => h.appDid
    ? { appAuth: { appDid: h.appDid } }
    : { error: 'No app token', status: 401 },
  requireAuth: async () => ({ identity: { id: 'did:imajin:human' } }),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

import { POST } from '../route';

vi.setConfig({ hookTimeout: 30_000 });
const client = new PGlite();
const APP = 'did:imajin:registeringapp';
const FOREIGN = 'did:imajin:foreignapp';
const root = resolve(__dirname, '../../../../../../..');
const migration = readFileSync(resolve(root, 'migrations/archive/pre-kernel-baseline/0212_identity_registering_app.sql'), 'utf8');

function register(ref = 'entity', metadata: Record<string, unknown> = {}) {
  return POST(new Request('https://kernel.test/registry/api/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      namespace: 'fixture', ref, type: 'course', metadata, registeredByAppDid: FOREIGN,
    }),
  }));
}

async function provenance(did: string) {
  const result = await client.query<{ registered_by_app_did: string | null }>(
    'SELECT registered_by_app_did FROM auth.identities WHERE id = $1', [did],
  );
  return result.rows[0].registered_by_app_did;
}

beforeAll(async () => {
  await client.exec(`CREATE SCHEMA auth;
    CREATE SCHEMA kernel;
    CREATE TABLE auth.identities (
      id text PRIMARY KEY, public_key text NOT NULL UNIQUE, scope text NOT NULL,
      subtype text, tier text NOT NULL DEFAULT 'soft', metadata jsonb DEFAULT '{}', suspended_at timestamptz,
      handle text, name text, avatar_url text, avatar_asset_id text, upload_limit_mb integer,
      handle_claimed_at timestamptz, contact_email text, key_roles jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE kernel.identity_aliases (
      namespace text NOT NULL, ref text NOT NULL, did text NOT NULL,
      created_at timestamptz DEFAULT now(), PRIMARY KEY(namespace, ref)
    );
    INSERT INTO auth.identities (id, public_key, scope) VALUES ('legacy', 'legacy-key', 'actor');`);
  await client.exec(migration);
  await client.exec(migration);
  h.db = drizzle(client);
});
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  h.appDid = APP;
  await client.exec("DELETE FROM kernel.identity_aliases; DELETE FROM auth.identities WHERE id <> 'legacy';");
});

describe('persisted registering-app provenance', () => {
  it('leaves pre-migration rows NULL after two replays', async () => {
    expect(await provenance('legacy')).toBeNull();
  });

  it('records only the authenticated app, not body or metadata claims', async () => {
    const response = await register('entity', { registeredByAppDid: FOREIGN, appDid: FOREIGN });
    expect(response.status).toBe(201);
    const { did } = await response.json();
    expect(await provenance(did)).toBe(APP);
  });

  it('does not transfer provenance when another app re-resolves the same alias', async () => {
    const { did } = await (await register()).json();
    h.appDid = FOREIGN;
    const response = await register('entity', { name: 'Updated', registeredByAppDid: FOREIGN });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ did, created: false });
    expect(await provenance(did)).toBe(APP);
  });

  it('leaves session registrations NULL, even when an app later resolves the alias', async () => {
    h.appDid = null;
    const { did } = await (await register()).json();
    expect(await provenance(did)).toBeNull();
    h.appDid = APP;
    expect((await register()).status).toBe(200);
    expect(await provenance(did)).toBeNull();
  });

  it('keeps app provenance request-local for interleaved registrations', async () => {
    const first = register('first');
    h.appDid = FOREIGN;
    const second = register('second');
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const [one, two] = await Promise.all(responses.map((response) => response.json()));
    expect(await provenance(one.did)).toBe(APP);
    expect(await provenance(two.did)).toBe(FOREIGN);
  });
});
