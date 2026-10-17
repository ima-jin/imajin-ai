import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  get db() { return state.db; },
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));
import { resolvePrivateReachAuthority } from '../agent-authority';

const pg = new PGlite();
const database = drizzle(pg);
const AGENT = 'did:imajin:delegate';
const PRINCIPAL = 'did:imajin:principal';

beforeAll(async () => {
  state.db = database;
  // Only columns used by production queries; not schema changes or migrations.
  await pg.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.identity_members (
      identity_did text, member_did text, role text, removed_at timestamptz
    );
    CREATE TABLE auth.delegation_grants (
      id text PRIMARY KEY, agent_did text, delegator_did text, audience jsonb,
      expires_at timestamptz, status text, last_used_at timestamptz
    );
    CREATE TABLE auth.delegation_grant_capabilities (
      grant_id text, capability text, status text
    );`);
});
beforeEach(async () => {
  await pg.exec('TRUNCATE auth.identity_members, auth.delegation_grants, auth.delegation_grant_capabilities');
  await pg.query("INSERT INTO auth.identity_members VALUES ($1, $2, 'agent', NULL)", [PRINCIPAL, AGENT]);
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await pg.close(); });

async function grant(options: {
  status?: string; expiresAt?: Date; capability?: string; capabilityStatus?: string;
  audience?: unknown; delegator?: string;
} = {}) {
  await pg.query('INSERT INTO auth.delegation_grants VALUES ($1, $2, $3, $4, $5, $6, NULL)', [
    'grant_fixture', AGENT, options.delegator ?? PRINCIPAL,
    JSON.stringify(options.audience ?? { type: 'all' }),
    options.expiresAt ?? new Date(Date.now() + 60_000), options.status ?? 'active',
  ]);
  await pg.query('INSERT INTO auth.delegation_grant_capabilities VALUES ($1, $2, $3)', [
    'grant_fixture', options.capability ?? 'messages:read', options.capabilityStatus ?? 'active',
  ]);
}

describe('private Reach authority is narrower than coarse bootstrap or requester authority', () => {
  it('preserves legacy active agent membership when this pair has no grant history', async () => {
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(true);
    await pg.exec("UPDATE auth.identity_members SET role = 'member'");
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
    await pg.exec("UPDATE auth.identity_members SET role = 'agent', removed_at = now()");
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
  });

  it.each([{ type: 'all' }, { type: 'dids', values: [PRINCIPAL] }])('allows current messages:read for matching audience %j without membership', async (audience) => {
    await grant({ audience });
    await pg.exec('TRUNCATE auth.identity_members');
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(true);
  });

  it.each([
    { status: 'revoked' },
    { expiresAt: new Date('2000-01-01T00:00:00Z') },
    { capabilityStatus: 'revoked' },
    { capability: 'agent:reach' },
    { capability: 'media:read' },
    { audience: { type: 'dids', values: ['did:imajin:someone-else'] } },
  ])('never falls back to surviving membership after the grant lifecycle starts: %j', async (options) => {
    await grant(options);
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
    vi.stubEnv('AGENT_AUTHORITY_MODE', 'membership-only');
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
  });

  it('sees whole grant/capability revocation and expiry on the very next check', async () => {
    await grant();
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(true);
    await pg.exec("UPDATE auth.delegation_grant_capabilities SET status = 'revoked'");
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
    await pg.exec("UPDATE auth.delegation_grant_capabilities SET status = 'active'");
    await pg.exec("UPDATE auth.delegation_grants SET status = 'revoked'");
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
    await pg.exec("UPDATE auth.delegation_grants SET status = 'active', expires_at = now() - interval '1 second'");
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
  });

  it('a grant from another principal neither supplies private read authority nor suppresses legacy membership for this pair', async () => {
    await grant({ delegator: 'did:imajin:other' });
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(true);
    await pg.exec('TRUNCATE auth.identity_members');
    expect(await resolvePrivateReachAuthority(AGENT, PRINCIPAL)).toBe(false);
  });

  it('propagates lookup failures so the internal endpoint denies', async () => {
    vi.spyOn(database, 'select').mockImplementationOnce(() => { throw new Error('unavailable'); });
    await expect(resolvePrivateReachAuthority(AGENT, PRINCIPAL)).rejects.toThrow('unavailable');
    vi.restoreAllMocks();
  });
});
