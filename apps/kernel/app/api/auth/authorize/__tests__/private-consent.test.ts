import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  database: undefined as PgliteDatabase | undefined,
  sessionDid: 'person',
  actingFor: undefined as string | undefined,
  failMembership: false,
  failRegistry: false,
  add: vi.fn(),
  promote: vi.fn(),
  project: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const registry = await import('@/src/db/schemas/registry');
  const oauth = await import('@/src/db/schemas/oauth');
  return {
    ...auth, ...registry, ...oauth,
    db: {
      select: (...args: Parameters<PgliteDatabase['select']>) => {
        const query = h.database!.select(...args);
        return { from: (table: unknown) => {
          if (h.failMembership && table === auth.identityMembers) throw new Error('lookup unavailable');
          if (h.failRegistry && table === registry.registryApps) throw new Error('registry unavailable');
          return query.from(table as never);
        } };
      },
      insert: (...args: Parameters<PgliteDatabase['insert']>) => h.database!.insert(...args),
    },
  };
});
vi.mock('@imajin/auth', () => ({
  requireAuth: async () => ({ identity: { id: h.sessionDid, actingFor: h.actingFor } }),
  resolveActingDid: (identity: { id: string; actingFor?: string }) => identity.actingFor ?? identity.id,
  validateScopes: (scopes: string[]) => ({ valid: scopes, invalid: [] }),
  canonicalize: JSON.stringify,
  crypto: { signSync: () => 'signature' },
}));
vi.mock('@/app/auth/lib/get-effective-did', () => ({
  getEffectiveDid: async () => ({ sessionDid: h.sessionDid, effectiveDid: h.actingFor }),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  withLogger: (_service: string, handler: unknown) => handler,
}));
vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/src/lib/kernel/app-membership', () => ({ addConsentedApp: h.add }));
vi.mock('@/src/lib/auth/promote-actor', () => ({ promoteActorOnGrant: h.promote }));
vi.mock('@/src/lib/auth/revoke-attestation', () => ({ revokeAttestationOnce: h.revoke }));
vi.mock('@/src/lib/auth/app-authorization-grant', () => ({ projectAppAuthorizationGrant: h.project }));
vi.mock('@/src/lib/kernel/consent-scope-projection', () => ({ projectConsentedScopes: h.project }));

import { POST as keypairConsent } from '../route';
import { POST as oauthConsent } from '@/app/oauth/authorize/route';
import { canConsentToApp } from '@/src/lib/kernel/app-consent';
import { canDiscoverApp } from '@/src/lib/kernel/app-visibility';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let client: PGlite;
beforeAll(async () => {
  client = new PGlite();
  h.database = drizzle(client);
  await client.exec(`
    CREATE SCHEMA auth;
    CREATE SCHEMA registry;
    CREATE TABLE auth.identities (id text PRIMARY KEY, scope text);
    CREATE TABLE auth.identity_members (identity_did text, member_did text, removed_at timestamptz);
    CREATE TABLE registry.apps (
      id text, slug text, app_did text, public_key text, status text,
      requested_scopes jsonb, callback_url text, name text, logo_url text,
      redirect_uris text[], visibility text, owner_did text, sign_in_audience text
    );
    CREATE TABLE auth.attestations (
      id text, issuer_did text, subject_did text, type text, context_id text,
      context_type text, payload jsonb, signature text, issued_at timestamptz,
      revoked_at timestamptz, expires_at timestamptz, cid text, nostr_sig text,
      author_jws text, witness_jws text, attestation_status text, document_hash text,
      document_asset_id text, total_signers integer, delegator_did text,
      disclosure_scope text, prev_event_ref text, delegation_grant_id text,
      supersedes text, ref text, lapsed_at timestamptz
    );
    CREATE TABLE auth.oauth_authorization_codes (
      id text, code_hash text, client_id text, user_did text, redirect_uri text,
      scope text, code_challenge text, code_challenge_method text, resource text,
      attestation_id text, expires_at timestamptz, used_at timestamptz, created_at timestamptz
    );
  `);
});
afterAll(async () => { await client?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  h.sessionDid = 'person';
  h.actingFor = undefined;
  h.failMembership = false;
  h.failRegistry = false;
  vi.stubEnv('AUTH_PRIVATE_KEY', 'test-signing-key');
  await client.exec(`
    TRUNCATE auth.identities, auth.identity_members, registry.apps, auth.attestations, auth.oauth_authorization_codes;
    INSERT INTO auth.identities VALUES ('owner','business'), ('person','actor'), ('other','actor');
    INSERT INTO registry.apps VALUES (
      'app_test','private-app','app-did','public-key','active',
      '["media:read"]','https://app.example.test/callback','Test app',NULL,
      ARRAY['https://app.example.test/callback'],'private','owner','members'
    );
  `);
});
afterAll(() => { vi.unstubAllEnvs(); });

const lanes = [
  { name: 'keypair', handler: keypairConsent, path: '/api/auth/authorize', success: 201,
    body: { appId: 'app_test', scopes: ['media:read'] } },
  { name: 'oauth', handler: oauthConsent, path: '/oauth/authorize', success: 200,
    body: { client_id: 'app_test', redirect_uri: 'https://app.example.test/callback',
      scope: 'media:read', code_challenge: 'challenge', code_challenge_method: 'S256' } },
];

async function assertNoConsentEffects() {
  expect(h.add).not.toHaveBeenCalled();
  expect(h.promote).not.toHaveBeenCalled();
  expect(h.project).not.toHaveBeenCalled();
  expect(h.revoke).not.toHaveBeenCalled();
  expect((await client.query('SELECT * FROM auth.oauth_authorization_codes')).rows).toEqual([]);
}

describe.each(lanes)('$name private sign-in audience', (lane) => {
  function consent() {
    return lane.handler(new NextRequest(`https://kernel.example.test${lane.path}`, {
      method: 'POST', body: JSON.stringify(lane.body),
    }));
  }

  it.each(['members', null, 'invalid'])('refuses a non-member with audience %s before any grant or list write', async (audience) => {
    await client.query('UPDATE registry.apps SET sign_in_audience = $1', [audience]);
    const response = await consent();
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain('owning identity and current members');
    await assertNoConsentEffects();
    expect((await client.query('SELECT * FROM auth.attestations')).rows).toEqual([]);
  });

  it('does not let an existing consent grant bypass membership or get superseded', async () => {
    await client.exec(`INSERT INTO auth.attestations (id,issuer_did,subject_did,type,payload)
      VALUES ('old','person','app-did','app.authorized','{"scopes":["media:read"]}')`);
    expect((await consent()).status).toBe(403);
    await assertNoConsentEffects();
    expect((await client.query('SELECT id FROM auth.attestations')).rows).toEqual([{ id: 'old' }]);
  });

  it.each(['owner', 'member'])('accepts the %s using the same live membership as discovery', async (viewer) => {
    if (viewer === 'owner') h.sessionDid = 'owner';
    else await client.exec("INSERT INTO auth.identity_members VALUES ('owner','person',NULL)");
    expect((await consent()).status).toBe(lane.success);
    expect(h.add).toHaveBeenCalledWith(h.sessionDid, 'private-app');
  });

  it('refuses departed members and personal-identity agent delegations', async () => {
    await client.exec("INSERT INTO auth.identity_members VALUES ('owner','person',NOW()), ('other','person',NULL)");
    expect((await consent()).status).toBe(403);
    await client.exec("UPDATE registry.apps SET owner_did = 'other'");
    expect((await consent()).status).toBe(403);
    await assertNoConsentEffects();
  });

  it('uses the consenting session, never an acting-for owner identity', async () => {
    h.actingFor = 'owner';
    expect((await consent()).status).toBe(403);
    await assertNoConsentEffects();
  });

  it('allows anyone by explicit choice without widening discovery', async () => {
    await client.exec("UPDATE registry.apps SET sign_in_audience = 'anyone'");
    expect((await consent()).status).toBe(lane.success);
    expect(h.add).toHaveBeenCalledWith('person', 'private-app');
    const app = { visibility: 'private', ownerDid: 'owner', signInAudience: 'anyone' };
    expect(canDiscoverApp(app, new Set(['person']))).toBe(false);
  });

  it('fails closed when live membership cannot be looked up', async () => {
    h.failMembership = true;
    expect((await consent()).status).toBe(403);
    await assertNoConsentEffects();
  });

  it('never consents when the registry lookup fails', async () => {
    h.failRegistry = true;
    await expect(consent()).rejects.toThrow('registry unavailable');
    await assertNoConsentEffects();
  });

  it('allows repeat consent for an explicit anyone app', async () => {
    await client.exec(`UPDATE registry.apps SET sign_in_audience = 'anyone';
      INSERT INTO auth.attestations (id,issuer_did,subject_did,type,payload)
      VALUES ('old','person','app-did','app.authorized','{"scopes":["media:read"]}')`);
    expect((await consent()).status).toBe(lane.success);
    expect(h.add).toHaveBeenCalledWith('person', 'private-app');
    expect((await client.query('SELECT id FROM auth.attestations')).rows).toEqual([{ id: 'old' }]);
  });

  it.each(['public', 'unlisted', 'internal'])('leaves %s consent unaffected and does not need membership lookup', async (visibility) => {
    await client.query('UPDATE registry.apps SET visibility = $1', [visibility]);
    h.failMembership = true;
    expect((await consent()).status).toBe(lane.success);
    expect(h.add).toHaveBeenCalledWith('person', 'private-app');
  });
});

it('refuses members-only private apps with no recorded owner', async () => {
  expect(await canConsentToApp({ visibility: 'private' }, 'person')).toBe(false);
});
