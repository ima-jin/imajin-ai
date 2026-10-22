import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';

const h = vi.hoisted(() => ({
  database: undefined as PgliteDatabase | undefined,
  failWrite: false,
  warn: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/oauth'),
  ...await import('@/src/db/schemas/registry'),
  db: {
    insert: (...args: Parameters<PgliteDatabase['insert']>) => {
      if (h.failWrite) throw new Error('database unavailable');
      return h.database!.insert(...args);
    },
    select: (...args: Parameters<PgliteDatabase['select']>) => h.database!.select(...args),
  },
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: h.warn }) }));
vi.mock('@/src/lib/auth/grants', () => ({ listGrantDetailsForDelegator: vi.fn() }));
vi.mock('@/src/lib/vault', () => ({ listVaultKeyCards: vi.fn() }));
vi.mock('@/src/lib/vault/mint', () => ({ mintedKeyField: vi.fn() }));
vi.mock('@/src/lib/access/delegate-grant', () => ({ listDelegateGrantBearersForPrincipal: vi.fn() }));
vi.mock('@/src/lib/vault/import-authority', () => ({ listImportOwners: vi.fn() }));

import { recordAppAuthorizationUse } from '../app-authorization-usage';
import { listAppAuthorizationsForOwner, normalizeAppAuthorizations } from '../../jin/grants-lane';

const migration = readFileSync(new URL('../../../../../../migrations/0219_app_authorization_usage.sql', import.meta.url), 'utf8');
let client: PGlite;
beforeAll(async () => {
  client = new PGlite();
  h.database = drizzle(client);
  await client.exec(`
    CREATE SCHEMA auth;
    CREATE SCHEMA registry;
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text, subject_did text, type text,
      payload jsonb, issued_at timestamptz, revoked_at timestamptz, expires_at timestamptz, signature text
    );
    CREATE TABLE registry.apps (app_did text, name text);
    CREATE TABLE auth.oauth_refresh_tokens (attestation_id text, created_at timestamptz, revoked_at timestamptz);
    INSERT INTO auth.attestations VALUES
      ('grant', 'owner', 'app', 'app.authorized', '{"scopes":["profile:read"]}', '2026-09-01', NULL, NULL, 'signed-original'),
      ('other-grant', 'other-owner', 'app', 'app.authorized', '{}', '2026-09-01', NULL, NULL, 'other-signature');
    INSERT INTO registry.apps VALUES ('app','Test app');
  `);
}, 30_000);
afterAll(async () => { await client?.close(); });

describe('app authorization usage storage (#3009)', () => {
  it('replays migration twice, keeps history, and atomically throttles competing writes per grant', async () => {
    await client.exec(migration);
    const before = await client.query('SELECT * FROM auth.attestations');
    await recordAppAuthorizationUse('grant');
    const first = await client.query('SELECT * FROM auth.app_authorization_usage');
    await client.exec(migration);
    expect(await client.query('SELECT * FROM auth.app_authorization_usage')).toEqual(first);
    await Promise.all(Array.from({ length: 10 }, () => recordAppAuthorizationUse('grant')));
    expect(await client.query('SELECT * FROM auth.app_authorization_usage')).toEqual(first);
    await recordAppAuthorizationUse('other-grant');
    expect((await client.query('SELECT use_count FROM auth.app_authorization_usage')).rows).toEqual([{ use_count: 1 }, { use_count: 1 }]);
    await client.exec(`UPDATE auth.app_authorization_usage SET last_used_at = clock_timestamp() - interval '61 seconds' WHERE attestation_id = 'grant'`);
    await Promise.all([recordAppAuthorizationUse('grant'), recordAppAuthorizationUse('grant')]);
    expect((await client.query(`SELECT use_count FROM auth.app_authorization_usage WHERE attestation_id = 'grant'`)).rows).toEqual([{ use_count: 2 }]);
    expect(await client.query('SELECT * FROM auth.attestations')).toEqual(before);
  });

  it('reads newest historical OAuth rotation including revoked predecessors, scoped to the owner and attestation', async () => {
    await client.exec(`
      UPDATE auth.app_authorization_usage SET last_used_at = '2026-10-10' WHERE attestation_id = 'grant';
      INSERT INTO auth.oauth_refresh_tokens VALUES
        ('grant', '2026-10-11', '2026-10-12'), ('grant', '2026-10-12', NULL),
        ('other-grant', '2026-10-20', NULL);
    `);
    const apps = await listAppAuthorizationsForOwner('owner');
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      recordedLastUsedAt: '2026-10-10T00:00:00.000Z', oauthLastUsedAt: '2026-10-12T00:00:00.000Z',
    });
    expect(normalizeAppAuthorizations(apps)[0].lastUsedAt).toBe('2026-10-12T00:00:00.000Z');
    await client.exec(`UPDATE auth.app_authorization_usage SET last_used_at = '2026-10-21' WHERE attestation_id = 'grant'`);
    expect(normalizeAppAuthorizations(await listAppAuthorizationsForOwner('owner'))[0].lastUsedAt).toBe('2026-10-21T00:00:00.000Z');
    expect(await listAppAuthorizationsForOwner('unrelated')).toEqual([]);
  });

  it('swallows write failures and logs no request data or identifiers', async () => {
    h.failWrite = true;
    await expect(recordAppAuthorizationUse('grant')).resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.warn).toHaveBeenCalledWith('app authorization usage recording unavailable');
    h.failWrite = false;
  });
});
