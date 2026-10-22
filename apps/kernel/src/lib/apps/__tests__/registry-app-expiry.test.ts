import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { canonicalize, crypto, ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';
import { forEachSequential } from '@/src/lib/async/sequential';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/auth'),
  db: new Proxy({}, { get: (_target, key) => {
    const db = holder.db as Record<string | symbol, unknown>;
    const value = db[key];
    return typeof value === 'function' ? value.bind(db) : value;
  } }),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:expiry-node' }));
import { expireRegistryApps, DCR_EXPIRY_BATCH_SIZE } from '../registry-app-expiry';
import { listRegisteredApps } from '../registered-apps';

let client: PGlite;
const keys = crypto.generateKeypair();
const now = Date.parse('2026-10-22T00:00:00Z');
const old = new Date(now - 8 * 86_400_000);
const migration = readFileSync(new URL('../../../../../../migrations/0220_registry_app_expiry_type.sql', import.meta.url), 'utf8');

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec(`
    CREATE SCHEMA registry; CREATE SCHEMA auth; CREATE SCHEMA kernel;
    CREATE TABLE registry.apps (id text PRIMARY KEY, app_did text, name text, tier text,
      status text, created_at timestamptz, updated_at timestamptz, revoked_at timestamptz,
      owner_did text, token_audiences text[] DEFAULT '{}');
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text, subject_did text, type text, context_id text, context_type text,
      payload jsonb, signature text NOT NULL, cid text, attestation_status text, issued_at timestamptz,
      nostr_sig text, author_jws text, witness_jws text, document_hash text, document_asset_id text,
      total_signers integer, delegator_did text, disclosure_scope jsonb, prev_event_ref text,
      delegation_grant_id text, supersedes text, ref text, expires_at timestamptz,
      revoked_at timestamptz, lapsed_at timestamptz
    );
    CREATE TABLE auth.attestation_type_registry (type_name text PRIMARY KEY, namespace text, description text);
    CREATE TABLE kernel.app_provisions (app_did text, created_at timestamptz);
    CREATE TABLE kernel.app_signing_key_claims (app_did text, created_at timestamptz, claimed_at timestamptz);
    CREATE TABLE auth.oauth_refresh_tokens (client_id text, created_at timestamptz, last_used_at timestamptz);
    CREATE TABLE auth.app_authorization_usage (attestation_id text, last_used_at timestamptz);
    CREATE TABLE registry.system_events (did text, action text, created_at timestamptz);
    CREATE TABLE registry.app_logs (metadata jsonb, message text, created_at timestamptz);
  `);
  holder.db = drizzle(client);
}, 30_000);
beforeEach(async () => {
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  await client.exec('TRUNCATE registry.apps, auth.attestations, kernel.app_provisions, kernel.app_signing_key_claims');
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await client?.close(); });

async function seed(id: string, options: { did?: string; tier?: string; status?: string; createdAt?: Date | null } = {}) {
  await client.query(`INSERT INTO registry.apps
    (id, app_did, name, tier, status, created_at, owner_did)
    VALUES ($1,$2,$1,$3,$4,$5,'did:imajin:registrar')`,
  [id, options.did ?? `did:imajin:mcp-${id}`, options.tier ?? 'third_party',
    options.status ?? 'active', options.createdAt === undefined ? old : options.createdAt]);
}
async function evidence() {
  return (await client.query<{
    id: string; issuer_did: string; subject_did: string; type: string; signature: string;
    context_id: string; context_type: string; payload: Record<string, unknown>; issued_at: Date;
  }>("SELECT * FROM auth.attestations WHERE type='registry.app.expired' ORDER BY context_id")).rows;
}
async function rows() {
  return (await client.query('SELECT * FROM registry.apps ORDER BY id')).rows;
}

describe('seven-day signed DCR lifecycle', () => {
  it('expires legacy rows once, verifies real signatures, and returns terminal provenance to Registered apps', async () => {
    await seed('abandoned');
    expect(await expireRegistryApps(now)).toEqual({ checked: 1, expired: 1 });
    const [proof] = await evidence();
    expect(proof).toMatchObject({
      issuer_did: 'did:imajin:expiry-node', subject_did: 'did:imajin:mcp-abandoned',
      type: 'registry.app.expired', context_id: 'abandoned', context_type: 'registry_app',
      payload: { appId: 'abandoned', reason: 'dcr-unconsented-ttl', ttlDays: 7, createdAt: old.toISOString() },
    });
    expect(crypto.verifySync(proof.signature, canonicalize({
      subject_did: proof.subject_did, type: proof.type, context_id: proof.context_id,
      context_type: proof.context_type, payload: proof.payload, issued_at: new Date(proof.issued_at).getTime(),
    }), keys.publicKey)).toBe(true);
    const apps = await listRegisteredApps();
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      status: 'expired', kind: 'MCP/DCR client',
      ended: { at: new Date(proof.issued_at).toISOString(), by: proof.issuer_did },
    });
    const before = await rows();
    expect(before[0]).toMatchObject({ status: 'expired', revoked_at: proof.issued_at, updated_at: proof.issued_at });
    expect(await expireRegistryApps(now)).toEqual({ checked: 0, expired: 0 });
    expect(await rows()).toEqual(before);
    expect(await evidence()).toHaveLength(1);
  });

  it('includes exactly seven days, never a millisecond younger, future, or unknown creation time', async () => {
    const cutoff = now - 7 * 86_400_000;
    await seed('boundary', { createdAt: new Date(cutoff) });
    await seed('young', { createdAt: new Date(cutoff + 1) });
    await seed('future', { createdAt: new Date(now + 1) });
    await seed('unknown', { createdAt: null });
    expect(await expireRegistryApps(now)).toEqual({ checked: 1, expired: 1 });
    expect((await evidence()).map(row => row.context_id)).toEqual(['boundary']);
    expect(await rows()).toHaveLength(4);
  });

  it.each(['live', 'revoked', 'expired'])('never expires a DCR with %s consent history', async state => {
    await seed(state);
    await client.query(`INSERT INTO auth.attestations
      (id, subject_did, type, signature, revoked_at, expires_at)
      VALUES ($1,$2,'app.authorized','historical',$3,$4)`,
    [state, `did:imajin:mcp-${state}`, state === 'revoked' ? old : null, state === 'expired' ? old : null]);
    expect(await expireRegistryApps(now)).toEqual({ checked: 0, expired: 0 });
    expect((await rows())[0].status).toBe('active');
    expect(await evidence()).toHaveLength(0);
  });

  it('protects any provision or claim, first-party DCRs, non-DCR legacy apps, and non-active rows', async () => {
    await seed('provisioned');
    await seed('claimed');
    await seed('first-party', { tier: 'first_party' });
    await seed('legacy', { did: 'did:imajin:BrokerAgent' });
    await seed('revoked', { status: 'revoked' });
    await seed('expired', { status: 'expired' });
    await seed('pending', { status: 'pending' });
    await client.query('INSERT INTO kernel.app_provisions (app_did) VALUES ($1)', ['did:imajin:mcp-provisioned']);
    await client.query('INSERT INTO kernel.app_signing_key_claims (app_did) VALUES ($1)', ['did:imajin:mcp-claimed']);
    const before = await rows();
    expect(await expireRegistryApps(now)).toEqual({ checked: 0, expired: 0 });
    expect(await rows()).toEqual(before);
  });

  it.each([35, 4])('sweeps the existing %i-row environment backlog on its first tick without cleanup SQL', async count => {
    await forEachSequential(Array.from({ length: count }, (_, i) => i), async i => { await seed(`legacy-${i}`); });
    expect(await expireRegistryApps(now)).toEqual({ checked: count, expired: count });
    expect(await rows()).toHaveLength(count);
    expect(await evidence()).toHaveLength(count);
  });

  it('bounds a tick to 100 oldest rows and finishes the remainder on the next tick', async () => {
    await forEachSequential(Array.from({ length: DCR_EXPIRY_BATCH_SIZE + 2 }, (_, i) => i), async i => {
      await seed(`batch-${i}`, { createdAt: new Date(old.getTime() + i) });
    });
    expect(await expireRegistryApps(now)).toEqual({ checked: 100, expired: 100 });
    expect((await rows()).filter(row => row.status === 'active').map(row => row.id)).toEqual(['batch-100', 'batch-101']);
    expect(await expireRegistryApps(now)).toEqual({ checked: 2, expired: 2 });
    expect(await expireRegistryApps(now)).toEqual({ checked: 0, expired: 0 });
    expect(await evidence()).toHaveLength(102);
    expect(await rows()).toHaveLength(102);
  });

  it('rolls back on missing signing authority or an evidence insert failure, including earlier writes in the batch', async () => {
    await seed('a');
    await seed('b');
    const before = await rows();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(expireRegistryApps(now)).rejects.toThrow('AUTH_PRIVATE_KEY');
    expect(await rows()).toEqual(before);
    vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
    await client.exec("ALTER TABLE auth.attestations ADD CONSTRAINT reject_b CHECK (context_id != 'b')");
    try {
      await expect(expireRegistryApps(now)).rejects.toThrow();
      expect(await rows()).toEqual(before);
      expect(await evidence()).toHaveLength(0);
    } finally {
      await client.exec('ALTER TABLE auth.attestations DROP CONSTRAINT reject_b');
    }
    expect(await expireRegistryApps(now)).toEqual({ checked: 2, expired: 2 });
  });

  it('registers the mechanical vocabulary and applies the type-registry seed idempotently', async () => {
    expect(ATTESTATION_TYPES).toContain('registry.app.expired');
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('registry.app.expired');
    await client.exec(migration);
    await client.exec(migration);
    expect((await client.query("SELECT * FROM auth.attestation_type_registry WHERE type_name='registry.app.expired'")).rows)
      .toEqual([{ type_name: 'registry.app.expired', namespace: 'platform', description: expect.stringContaining('ttlDays=7') }]);
  });
});
