import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { NextRequest } from 'next/server';
import { generateKeypair, crypto as authCrypto } from '@imajin/auth';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({
  database: undefined as PgliteDatabase | undefined,
  principal: 'person',
  failMembership: false,
  failRegistry: false,
  mint: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const registry = await import('@/src/db/schemas/registry');
  const oauth = await import('@/src/db/schemas/oauth');
  const codes = await import('@/src/db/schemas/app-authorization-codes');
  return {
    ...auth, ...registry, ...oauth, ...codes,
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
vi.mock('@/src/lib/auth/crypto', () => ({ verifySignature: h.verify }));
vi.mock('@/src/lib/auth/require-internal-api-key', () => ({ requireInternalApiKey: async () => null }));

import { POST as keypairToken } from '../token/route';
import { POST as validate } from '../validate/route';
import { POST as oauthToken } from '@/app/oauth/token/route';
import { hashToken, MCP_SCOPES, pkceChallengeFromVerifier } from '@/src/lib/mcp/oauth-config';
import { issueAppAuthorizationCode } from '@/src/lib/auth/app-authorization-code';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const REDIRECT = 'https://app.example.test/callback';
const VERIFIER = 'test-pkce-verifier-for-membership-regression';
let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  h.database = drizzle(client);
  await client.exec('CREATE SCHEMA IF NOT EXISTS auth');
  await client.exec(readFileSync('migrations/0222_app_authorization_codes.sql', 'utf8'));
  await client.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA registry;
    CREATE TABLE auth.identities (id text PRIMARY KEY, scope text);
    CREATE TABLE auth.identity_members (identity_did text, member_did text, removed_at timestamptz);
    CREATE TABLE registry.apps (
      id text, app_did text, public_key text, status text, requested_scopes jsonb,
      visibility text, owner_did text, sign_in_audience text, name text,
      tier text, slug text, provides_scopes jsonb, depends_on jsonb,
      act_as_allowed boolean, token_audiences text[],
      callback_url text DEFAULT 'https://app.example.test/callback'
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
  h.principal = 'person';
  h.failMembership = false;
  h.failRegistry = false;
  h.mint.mockResolvedValue('signed.app.jwt');
  h.verify.mockResolvedValue(true);
  await client.exec(`
    TRUNCATE auth.identities, auth.identity_members, registry.apps, auth.attestations,
      auth.oauth_authorization_codes, auth.oauth_refresh_tokens;
    INSERT INTO auth.identities VALUES ('owner','business'), ('person','actor'), ('other','actor');
    INSERT INTO auth.identity_members VALUES ('owner','person',NULL);
    INSERT INTO auth.attestations (id,issuer_did,subject_did,type,payload)
      VALUES ('grant','person','app-did','app.authorized','{"scopes":["profile:read"]}');
  `);
  await client.query(`INSERT INTO registry.apps
    (id,app_did,public_key,status,requested_scopes,visibility,owner_did,sign_in_audience,name,token_audiences)
    VALUES ('app_test','app-did','public-key','active',$1,'private','owner','members','Test app',ARRAY['app_test'])`,
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
  { name: 'principal mint', refused: 403, call: () => keypairToken(jsonRequest('/auth/api/apps/token', {
    appDid: 'app-did', principalDid: h.principal, nonce: 'n'.repeat(16),
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

function principalBody(overrides: Record<string, unknown> = {}) {
  return {
    appDid: 'app-did', principalDid: 'person', nonce: 'n'.repeat(16),
    timestamp: new Date().toISOString(), signature: 'test-signature', ...overrides,
  };
}

function mintPrincipal(overrides: Record<string, unknown> = {}) {
  return keypairToken(jsonRequest('/auth/api/apps/token', principalBody(overrides)));
}

describe('single-use app sign-in code exchange with PostgreSQL', () => {
  const state = 's'.repeat(64);
  async function issue(extra = {}) {
    return issueAppAuthorizationCode({
      appDid: 'app-did', subjectDid: 'person', attestationId: 'grant',
      callbackUrl: REDIRECT, state, ...extra,
    });
  }
  function exchange(code: string, extra = {}) {
    return keypairToken(jsonRequest('/auth/api/apps/token', {
      appDid: 'app-did', code, state, nonce: 'n'.repeat(16),
      timestamp: new Date().toISOString(), signature: 'test-signature', ...extra,
    }));
  }

  it('returns the kernel subject once, retains the consumed record and refuses reuse', async () => {
    const code = await issue();
    const response = await exchange(code);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subjectDid: 'person', attestationId: 'grant' });
    h.mint.mockClear();
    const reused = await exchange(code);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toEqual({ error: 'code_used' });
    expect(h.mint).not.toHaveBeenCalled();
    const retained = await client.query('SELECT consumed_at FROM auth.app_authorization_codes WHERE app_did = $1', ['app-did']);
    expect(retained.rows.some(row => row.consumed_at !== null)).toBe(true);
  });

  it('admits only one concurrent consumer', async () => {
    const code = await issue();
    const responses = await Promise.all([exchange(code), exchange(code)]);
    expect(responses.map(response => response.status).toSorted()).toEqual([200, 400]);
    expect(h.mint).toHaveBeenCalledOnce();
  });

  it('reapplies the migration idempotently without changing retained code history', async () => {
    const code = await issue();
    expect((await exchange(code)).status).toBe(200);
    const before = await client.query('SELECT * FROM auth.app_authorization_codes ORDER BY code_hash');
    await client.exec(readFileSync('migrations/0222_app_authorization_codes.sql', 'utf8'));
    expect(await client.query('SELECT * FROM auth.app_authorization_codes ORDER BY code_hash')).toEqual(before);
  });

  it.each(['unissued', 'expired', 'foreign-app', 'state-mismatch', 'callback-mismatch'])(
    'refuses %s with no token', async failure => {
      const code = failure === 'unissued' ? 'f'.repeat(64) : await issue(
        failure === 'foreign-app' ? { appDid: 'another-app' } : {},
      );
      if (failure === 'expired') await client.exec('UPDATE auth.app_authorization_codes SET expires_at = NOW()');
      if (failure === 'callback-mismatch') await client.exec("UPDATE registry.apps SET callback_url = 'https://changed.test'");
      const response = await exchange(code, failure === 'state-mismatch' ? { state: 'x'.repeat(64) } : {});
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'code_invalid' });
      expect(h.mint).not.toHaveBeenCalled();
    },
  );

  it.each(['revoked', 'expired', 'foreign-subject', 'foreign-app', 'wrong-type'])(
    'refuses a %s linked authorization', async failure => {
      const code = await issue();
      const updates = {
        revoked: 'revoked_at = NOW()', expired: 'expires_at = NOW()',
        'foreign-subject': "issuer_did = 'other'", 'foreign-app': "subject_did = 'other-app'",
        'wrong-type': "type = 'other.type'",
      };
      await client.exec(`UPDATE auth.attestations SET ${updates[failure as keyof typeof updates]}`);
      expect((await exchange(code)).status).toBeGreaterThanOrEqual(400);
      expect(h.mint).not.toHaveBeenCalled();
    },
  );

  it('checks live private-app membership at exchange time', async () => {
    const code = await issue();
    await client.exec('UPDATE auth.identity_members SET removed_at = NOW()');
    expect((await exchange(code)).status).toBe(403);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('verifies the real registered-key signature over the code', async () => {
    const { verifySignature } = await vi.importActual<typeof import('@/src/lib/auth/crypto')>('@/src/lib/auth/crypto');
    h.verify.mockImplementation(verifySignature);
    const keys = generateKeypair();
    await client.query('UPDATE registry.apps SET public_key = $1', [keys.publicKey]);
    const code = await issue();
    const timestamp = new Date().toISOString();
    const signature = authCrypto.signSync(`app-did:${code}:${'n'.repeat(16)}:${timestamp}`, keys.privateKey);
    expect((await exchange(code, { timestamp, signature })).status).toBe(200);
  });
});

describe('live principal mint (#3040)', () => {
  it('mints the same claims and response as by ID, without narrowing or with scope/aud', async () => {
    await client.exec(`UPDATE auth.attestations SET payload = '{"scopes":["profile:read","infer:chat"]}'`);
    const before = await client.query('SELECT * FROM auth.attestations');
    for (const options of [{}, { scope: 'profile:read', aud: 'app_test' }]) {
      const byPrincipal = await mintPrincipal(options);
      expect(byPrincipal.status).toBe(200);
      const claims = h.mint.mock.lastCall![0];
      const byId = await mintPrincipal({ ...options, principalDid: undefined, attestationId: 'grant' });
      expect(byId.status).toBe(200);
      expect(await byPrincipal.json()).toEqual(await byId.json());
      expect(h.mint.mock.lastCall![0]).toEqual(claims);
      expect(claims).toEqual({
        sub: 'person', azp: 'app-did', attestationId: 'grant',
        scope: options.scope ?? 'profile:read infer:chat', aud: options.aud,
      });
    }
    expect(await client.query('SELECT * FROM auth.attestations')).toEqual(before);
  });

  it('finds the new live grant on the next identical request after re-consent', async () => {
    const body = principalBody();
    expect((await keypairToken(jsonRequest('/auth/api/apps/token', body))).status).toBe(200);
    await client.exec(`
      UPDATE auth.attestations SET revoked_at = NOW() WHERE id = 'grant';
      INSERT INTO auth.attestations (id,issuer_did,subject_did,type,payload,expires_at)
        VALUES ('new-grant','person','app-did','app.authorized',
          '{"scopes":["profile:read","infer:chat"]}', NOW() + INTERVAL '1 hour');
    `);
    expect((await keypairToken(jsonRequest('/auth/api/apps/token', body))).status).toBe(200);
    expect(h.mint.mock.lastCall![0]).toMatchObject({
      sub: 'person', attestationId: 'new-grant', scope: 'profile:read infer:chat',
    });
    expect((await client.query('SELECT id, revoked_at IS NOT NULL AS revoked FROM auth.attestations ORDER BY id')).rows)
      .toEqual([{ id: 'grant', revoked: true }, { id: 'new-grant', revoked: false }]);
  });

  it.each([
    ['none', "UPDATE auth.attestations SET issuer_did = 'other'"],
    ['revoked', 'UPDATE auth.attestations SET revoked_at = NOW()'],
    ['expired', "UPDATE auth.attestations SET expires_at = NOW() - INTERVAL '1 second'"],
    ['wrong app', "UPDATE auth.attestations SET subject_did = 'other-app'"],
    ['wrong type', "UPDATE auth.attestations SET type = 'other.type'"],
  ])('refuses %s with a stable recovery message and no token', async (_name, sql) => {
    await client.exec(sql);
    const res = await mintPrincipal();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'no_live_grant', error: 'Re-grant Test app on /jin → Grants' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
    expect(h.mint).not.toHaveBeenCalled();
  });

  it.each([
    { principalDid: undefined },
    { principalDid: '' },
    { principalDid: null },
    { principalDid: 123 },
    { principalDid: ['person'] },
    { principalDid: {} },
    { attestationId: 'grant' },
    { attestationId: '' },
    { attestationId: null },
    { principalDid: undefined, attestationId: 123 },
  ])('rejects an invalid or ambiguous selector: %j', async (overrides) => {
    expect((await mintPrincipal(overrides)).status).toBe(400);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('rejects a grant expiring exactly now using the shared live-grant rule', async () => {
    const now = Date.now();
    await client.query('UPDATE auth.attestations SET expires_at = $1', [new Date(now).toISOString()]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const response = await mintPrincipal();
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('no_live_grant');
      expect(h.mint).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    [{ nonce: 'short' }, 400],
    [{ timestamp: 'invalid' }, 401],
    [{ timestamp: '2000-01-01T00:00:00.000Z' }, 401],
    [{ timestamp: '2100-01-01T00:00:00.000Z' }, 401],
    [{ signature: '' }, 400],
    [{ appDid: '' }, 400],
  ])('preserves request validation for %j', async (overrides, status) => {
    expect((await mintPrincipal(overrides)).status).toBe(status);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('accepts only a registered-key signature covering the requested principal', async () => {
    const { verifySignature } = await vi.importActual<typeof import('@/src/lib/auth/crypto')>('@/src/lib/auth/crypto');
    h.verify.mockImplementation(verifySignature);
    const appKeys = generateKeypair();
    const otherKeys = generateKeypair();
    await client.query('UPDATE registry.apps SET public_key = $1', [appKeys.publicKey]);
    const body = principalBody();
    const challenge = (selector: string) => `${body.appDid}:${selector}:${body.nonce}:${body.timestamp}`;
    for (const [selector, key, status] of [
      ['person', appKeys.privateKey, 200],
      ['grant', appKeys.privateKey, 401],
      ['other', appKeys.privateKey, 401],
      ['person', otherKeys.privateKey, 401],
    ] as const) {
      h.mint.mockClear();
      const response = await keypairToken(jsonRequest('/auth/api/apps/token', {
        ...body, signature: authCrypto.signSync(challenge(selector), key),
      }));
      expect(response.status).toBe(status);
      expect(h.mint).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    }
    const byId = await keypairToken(jsonRequest('/auth/api/apps/token', {
      ...body, principalDid: undefined, attestationId: 'grant',
      signature: authCrypto.signSync(challenge('grant'), appKeys.privateKey),
    }));
    expect(byId.status).toBe(200);
  });

  it.each(['revoked', 'pending'])('rejects a %s app on both paths', async (status) => {
    await client.query('UPDATE registry.apps SET status = $1', [status]);
    expect((await mintPrincipal()).status).toBe(403);
    expect((await mintPrincipal({ principalDid: undefined, attestationId: 'grant' })).status).toBe(403);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('rejects an unknown app', async () => {
    expect((await mintPrincipal({ appDid: 'unknown' })).status).toBe(404);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it.each([{}, { principalDid: undefined, attestationId: 'grant' }])('enforces scope and audience for %j', async (selector) => {
    expect((await mintPrincipal({ ...selector, scope: 'infer:chat' })).status).toBe(403);
    const response = await mintPrincipal({ ...selector, aud: 'unknown' });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('app_not_registered');
    expect(h.mint).not.toHaveBeenCalled();
  });

  it('preserves by-ID missing and revoked errors', async () => {
    const missing = await mintPrincipal({ principalDid: undefined, attestationId: 'missing' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Authorization not found' });
    await client.exec('UPDATE auth.attestations SET revoked_at = NOW()');
    const revoked = await mintPrincipal({ principalDid: undefined, attestationId: 'grant' });
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({ error: 'Authorization has been revoked' });
    expect(h.mint).not.toHaveBeenCalled();
  });
});

describe.each(lanes)('$name live private membership (#2984)', (lane) => {
  async function refused() {
    const response = await lane.call();
    expect(response.status).toBe(lane.refused);
    expect(JSON.stringify(await response.json())).toContain('owning identity and current members');
    if (lane.name.startsWith('OAuth')) expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (lane.name.endsWith('mint')) {
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.test');
    }
    await assertNoTokenEffects();
  }

  it.each(['member', 'owner'])('accepts the current %s', async (principal) => {
    if (principal === 'owner') {
      h.principal = 'owner';
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
