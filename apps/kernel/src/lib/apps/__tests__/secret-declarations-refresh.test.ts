import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { canonicalize, crypto } from '@imajin/auth';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const holder = vi.hoisted(() => ({ db: null as unknown, manifest: vi.fn(), prepare: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/app-provisions'),
  ...await import('@/src/db/schemas/app-signing-key-claims'),
  operatorApprovals: {},
  db: new Proxy({}, { get: (_target, key) => {
    const db = holder.db as Record<string | symbol, unknown>;
    const value = db[key];
    return typeof value === 'function' ? value.bind(db) : value;
  } }),
}));
vi.mock('@/src/lib/github/org-provisioning', () => ({
  fetchAppManifest: holder.manifest, tryGetInstallationToken: async () => null,
  appManifestError: () => 'Fixture manifest unavailable',
}));
vi.mock('@/src/lib/apps/self-secrets', () => ({}));
vi.mock('@/src/lib/apps/secret-staging', () => ({}));
vi.mock('@/src/lib/notify/operator-approvals', () => ({}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:fixture-node' }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', async (original) => {
  const actual = await original<typeof import('@/src/lib/auth/emit-mechanical-attestation')>();
  holder.prepare.mockImplementation(actual.prepareMechanicalAttestation);
  return { ...actual, prepareMechanicalAttestation: holder.prepare };
});
import { executeAppSecretsApproval } from '../secrets-operator';

let client: PGlite;
const keys = crypto.generateKeypair();
const appDid = 'did:imajin:fixture-app';
const added = { name: 'LEGACY_DATABASE_URL', kind: 'operator-supplied' };
const existing = { name: 'EXISTING_SECRET', kind: 'random-32B' };
const card = {
  proposalId: 'fixture-approved', source: 'apps', kind: 'apps:secrets-sync', status: 'approved',
  contentHash: 'fixture-signed-content',
  // Execution receives this only after the decision service verifies the signature.
  decision: { decision: 'approve', decidedAt: '2026-10-26T00:00:00Z',
    decidedBy: 'did:imajin:fixture-operator', operatorSignature: { keyId: 'fixture-key', alg: 'ed25519', sig: 'fixture-verified' } },
  detail: { appDid, slug: 'fixture-app', secrets: [added] },
} as OperatorApprovalCard;

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec(`
    CREATE SCHEMA registry; CREATE SCHEMA auth; CREATE SCHEMA kernel;
    CREATE TABLE registry.apps (
      id text PRIMARY KEY, app_did text, slug text, status text, secrets jsonb,
      public_key text, owner_did text, provides_scopes jsonb, depends_on jsonb,
      emittable_events jsonb, updated_at timestamptz
    );
    CREATE TABLE kernel.app_signing_key_claims (
      app_did text, status text, bootstrap_key_revoked_at timestamptz, claim_code_hash text
    );
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text, subject_did text, type text, context_id text, context_type text,
      payload jsonb, signature text NOT NULL, cid text, attestation_status text, issued_at timestamptz,
      nostr_sig text, author_jws text, witness_jws text, document_hash text, document_asset_id text,
      total_signers integer, delegator_did text, disclosure_scope jsonb, prev_event_ref text,
      delegation_grant_id text, supersedes text, ref text, expires_at timestamptz,
      revoked_at timestamptz, lapsed_at timestamptz
    );
  `);
  holder.db = drizzle(client);
}, 30_000);
beforeEach(async () => {
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  holder.prepare.mockClear();
  holder.manifest.mockResolvedValue({ ok: {
    secrets: [added], providesScopes: ['fixture:admin'], emittableEvents: ['new.event'],
    dependsOn: [{ aud: 'other-service', scopes: ['write'] }],
  } });
  await client.exec('TRUNCATE registry.apps, kernel.app_signing_key_claims, auth.attestations');
  await client.query(`INSERT INTO registry.apps VALUES
    ('app_fixture',$1,'fixture-app','active',$2,'fixture-public-key','did:imajin:fixture-owner',
    '["fixture:read"]','[]','[]','2026-10-01T00:00:00Z')`, [appDid, JSON.stringify([existing])]);
  await client.query(`INSERT INTO kernel.app_signing_key_claims VALUES ($1,'claimed',null,'fixture-claim-hash')`, [appDid]);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await client?.close(); });

async function row() { return (await client.query('SELECT * FROM registry.apps')).rows[0]; }
async function claims() { return (await client.query('SELECT * FROM kernel.app_signing_key_claims')).rows; }
async function evidence() {
  return (await client.query<{
    issuer_did: string; subject_did: string; type: string; context_id: string; context_type: string;
    payload: Record<string, unknown>; signature: string; issued_at: Date;
  }>('SELECT * FROM auth.attestations')).rows;
}

describe('declaration refresh SQL and signed history', () => {
  it('appends only the approved slot, preserves all other registry columns and claims, and retries without duplicates', async () => {
    const before = await row();
    const beforeClaims = await claims();
    expect((await executeAppSecretsApproval(card)).ok).toBe(true);
    expect(await row()).toEqual({ ...before, secrets: [existing, added] });
    expect(await claims()).toEqual(beforeClaims);
    const [proof] = await evidence();
    expect(proof.type).toBe('apps.secrets.declarations-refreshed');
    expect(proof.payload).toMatchObject({
      additions: [added], authorizedBy: { approvalId: card.proposalId, contentHash: card.contentHash },
    });
    expect(crypto.verifySync(proof.signature, canonicalize({
      subject_did: proof.subject_did, type: proof.type, context_id: proof.context_id,
      context_type: proof.context_type, payload: proof.payload, issued_at: new Date(proof.issued_at).getTime(),
    }), keys.publicKey)).toBe(true);
    expect(await executeAppSecretsApproval(card)).toMatchObject({ ok: true, data: { names: [] } });
    expect(await row()).toEqual({ ...before, secrets: [existing, added] });
    expect(await evidence()).toHaveLength(1);
  });
  it('rolls back the declaration update if its audit insert fails', async () => {
    const before = await row();
    await client.exec("ALTER TABLE auth.attestations ADD CONSTRAINT reject_fixture CHECK (type != 'apps.secrets.declarations-refreshed')");
    try {
      expect((await executeAppSecretsApproval(card)).ok).toBe(false);
      expect(await row()).toEqual(before);
      expect(await evidence()).toHaveLength(0);
    } finally {
      await client.exec('ALTER TABLE auth.attestations DROP CONSTRAINT reject_fixture');
    }
  });
  it('refuses unsigned execution and missing node signing authority without a registry write', async () => {
    const before = await row();
    expect((await executeAppSecretsApproval({ ...card, decision: null })).ok).toBe(false);
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await executeAppSecretsApproval(card)).ok).toBe(false);
    expect(await row()).toEqual(before);
    expect(await evidence()).toHaveLength(0);
  });
  it('does not overwrite a concurrent append or attest a failed compare-and-set', async () => {
    const concurrent = { name: 'CONCURRENT_SECRET', kind: 'operator-supplied' };
    const { prepareMechanicalAttestation } = await vi.importActual<typeof import('@/src/lib/auth/emit-mechanical-attestation')>(
      '@/src/lib/auth/emit-mechanical-attestation');
    holder.prepare.mockImplementationOnce(async (...args) => {
      await client.query('UPDATE registry.apps SET secrets=$1 WHERE app_did=$2', [JSON.stringify([existing, concurrent]), appDid]);
      return prepareMechanicalAttestation(...args as Parameters<typeof prepareMechanicalAttestation>);
    });
    expect((await executeAppSecretsApproval(card)).ok).toBe(false);
    expect((await row()).secrets).toEqual([existing, concurrent]);
    expect(await evidence()).toHaveLength(0);
    expect((await executeAppSecretsApproval(card)).ok).toBe(true);
    expect((await row()).secrets).toEqual([existing, concurrent, added]);
  });
});
