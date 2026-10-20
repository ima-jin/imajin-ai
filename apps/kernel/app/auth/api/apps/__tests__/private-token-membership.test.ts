import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  database: undefined as PgliteDatabase | undefined,
  failMembership: false,
  failRegistry: false,
  mint: vi.fn(),
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
          if (h.failMembership && table === auth.identityMembers) throw new Error('membership unavailable');
          if (h.failRegistry && table === registry.registryApps) throw new Error('registry unavailable');
          return query.from(table as never);
        } };
      },
      insert: (...args: Parameters<PgliteDatabase['insert']>) => h.database!.insert(...args),
      update: (...args: Parameters<PgliteDatabase['update']>) => h.database!.update(...args),
    },
  };
});
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false }),
  getClientIP: () => '127.0.0.1',
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.example.test' }),
}));
vi.mock('@/src/lib/auth/jwt', () => ({ createAppToken: h.mint }));
vi.mock('@/src/lib/auth/crypto', () => ({ verifySignature: async () => true }));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: async () => null }));

import { POST as keypairToken } from '../token/route';
import { POST as validate } from '../validate/route';
import { POST as oauthToken } from '@/app/oauth/token/route';
import { hashToken, MCP_SCOPES, pkceChallengeFromVerifier } from '@/src/lib/mcp/oauth-config';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const REDIRECT = 'https://app.example.test/callback';
const VERIFIER = 'test-pkce-verifier-for-membership-regression';
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
      id text, app_did text, public_key text, status text, requested_scopes jsonb,
      visibility text, owner_did text, sign_in_audience text
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
    CREATE TABLE auth.oauth_refresh_tokens (
      id text, token_hash text, client_id text, user_did text, scope text, attestation_id text,
      rotated_to text, expires_at timestamptz, revoked_at timestamptz, created_at timestamptz,
      last_used_at timestamptz
    );
  `);
});
afterAll(async () => { await client?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  h.failMembership = false;
  h.failRegistry = false;
  h.mint.mockResolvedValue('signed.app.jwt');
  await client.exec(`
    TRUNCATE auth.identities, auth.identity_members, registry.apps, auth.attestations,
      auth.oauth_authorization_codes, auth.oauth_refresh_tokens;
    INSERT INTO auth.identities VALUES ('owner','business'), ('person','actor'), ('other','actor');
    INSERT INTO auth.identity_members VALUES ('owner','person',NULL);
    INSERT INTO auth.attestations (id,issuer_did,subject_did,type,payload)
      VALUES ('grant','person','app-did','app.authorized','{"scopes":["profile:read"]}');
  `);
  await client.query(`INSERT INTO registry.apps VALUES
    ('app_test','app-did','public-key','active',$1,'private','owner','members')`,
  [JSON.stringify([MCP_SCOPES[0]])]);
  await client.query(`INSERT INTO auth.oauth_authorization_codes
    (id,code_hash,client_id,user_did,redirect_uri,scope,code_challenge,code_challenge_method,attestation_id,expires_at)
    VALUES ('code',$1,'app_test','person',$2,$3,$4,'S256','grant',NOW() + INTERVAL '1 hour')`,
  [hashToken('test-code'), REDIRECT, MCP_SCOPES[0], pkceChallengeFromVerifier(VERIFIER)]);
  await client.query(`INSERT INTO auth.oauth_refresh_tokens
    (id,token_hash,client_id,user_did,scope,attestation_id,expires_at)
    VALUES ('refresh',$1,'app_test','person',$2,'grant',NOW() + INTERVAL '1 day')`,
  [hashToken('test-refresh'), MCP_SCOPES[0]]);
});

function jsonRequest(path: string, body: Record<string, unknown>) {
  return new NextRequest(`https://kernel.example.test${path}`, {
    method: 'POST', body: JSON.stringify(body),
  });
}
function oauthRequest(grantType: string) {
  const body = new URLSearchParams({
    grant_type: grantType, client_id: 'app_test',
    code: 'test-code', redirect_uri: REDIRECT, code_verifier: VERIFIER,
    refresh_token: 'test-refresh',
  });
  return new NextRequest('https://kernel.example.test/oauth/token', { method: 'POST', body });
}
const lanes = [
  { name: 'keypair mint', refused: 403, call: () => keypairToken(jsonRequest('/auth/api/apps/token', {
    appDid: 'app-did', attestationId: 'grant', nonce: 'n'.repeat(16),
    timestamp: new Date().toISOString(), signature: 'test-signature',
  })) },
  { name: 'validate', refused: 403, call: () => validate(jsonRequest('/auth/api/apps/validate', {
    appDid: 'app-did', attestationId: 'grant',
  })) },
  { name: 'OAuth issue', refused: 400, call: () => oauthToken(oauthRequest('authorization_code')) },
  { name: 'OAuth refresh', refused: 400, call: () => oauthToken(oauthRequest('refresh_token')) },
];

async function assertNoTokenEffects() {
  expect(h.mint).not.toHaveBeenCalled();
  expect((await client.query('SELECT id, revoked_at, rotated_to, last_used_at FROM auth.oauth_refresh_tokens')).rows)
    .toEqual([{ id: 'refresh', revoked_at: null, rotated_to: null, last_used_at: null }]);
  expect((await client.query('SELECT id, revoked_at FROM auth.attestations')).rows)
    .toEqual([{ id: 'grant', revoked_at: null }]);
}

describe.each(lanes)('$name live private membership (#2984)', (lane) => {
  async function refused() {
    const response = await lane.call();
    expect(response.status).toBe(lane.refused);
    expect(JSON.stringify(await response.json())).toContain('owning identity and current members');
    if (lane.name.startsWith('OAuth')) expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (lane.name === 'keypair mint') {
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
    }
    await assertNoTokenEffects();
  }

  it.each(['member', 'owner'])('accepts the current %s', async (principal) => {
    if (principal === 'owner') {
      await client.exec(`
        UPDATE auth.attestations SET issuer_did = 'owner';
        UPDATE auth.oauth_authorization_codes SET user_did = 'owner';
        UPDATE auth.oauth_refresh_tokens SET user_did = 'owner';
      `);
    }
    expect((await lane.call()).status).toBe(200);
    if (lane.name !== 'validate') {
      expect(h.mint).toHaveBeenCalledWith(expect.objectContaining({
        sub: principal === 'owner' ? 'owner' : 'person', azp: 'app-did', attestationId: 'grant',
      }));
    }
  });

  it('refuses departure even though consent is still live', async () => {
    await client.exec("UPDATE auth.identity_members SET removed_at = NOW()");
    await refused();
  });

  it('fails closed on a live membership resolver error', async () => {
    h.failMembership = true;
    await refused();
  });

  it('does not substitute the app owner or an unrelated membership for the consenting user', async () => {
    await client.exec(`
      DELETE FROM auth.identity_members;
      INSERT INTO auth.identity_members VALUES ('owner','app-did',NULL), ('other','person',NULL);
    `);
    await refused();
  });

  it.each([null, 'invalid'])('treats audience %s as members-only', async (audience) => {
    await client.query('UPDATE registry.apps SET sign_in_audience = $1', [audience]);
    await client.exec("UPDATE auth.identity_members SET removed_at = NOW()");
    await refused();
  });

  it('fails closed for a private members-only app without an owner', async () => {
    await client.exec('UPDATE registry.apps SET owner_did = NULL');
    await refused();
  });

  it('allows a departed member for explicit anyone without needing the resolver', async () => {
    await client.exec(`
      UPDATE registry.apps SET sign_in_audience = 'anyone';
      UPDATE auth.identity_members SET removed_at = NOW();
    `);
    h.failMembership = true;
    expect((await lane.call()).status).toBe(200);
  });

  it.each(['public', 'unlisted', 'internal'])('preserves %s behavior without membership lookup', async (visibility) => {
    await client.query('UPDATE registry.apps SET visibility = $1', [visibility]);
    h.failMembership = true;
    expect((await lane.call()).status).toBe(200);
  });

  it('applies a current members-only policy to a grant created under anyone', async () => {
    await client.exec(`
      UPDATE registry.apps SET sign_in_audience = 'anyone';
      DELETE FROM auth.identity_members;
      UPDATE registry.apps SET sign_in_audience = 'members';
    `);
    await refused();
  });

  it('never authorizes when the registration lookup fails', async () => {
    h.failRegistry = true;
    await expect(lane.call()).rejects.toThrow('registry unavailable');
    await assertNoTokenEffects();
  });
});
