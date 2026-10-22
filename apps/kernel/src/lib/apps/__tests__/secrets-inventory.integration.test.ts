import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { registryApps } from '@/src/db/schemas/registry';
import { appProvisions } from '@/src/db/schemas/app-provisions';
import { appSigningKeyClaims } from '@/src/db/schemas/app-signing-key-claims';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';

const holder = vi.hoisted(() => ({ db: null as unknown, list: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/app-provisions'),
  ...await import('@/src/db/schemas/app-signing-key-claims'),
  ...await import('@/src/db/schemas/operator-approvals'),
  db: new Proxy({}, { get: (_target, key) => {
    const db = holder.db as Record<string | symbol, unknown>;
    const value = db[key];
    return typeof value === 'function' ? value.bind(db) : value;
  } }),
}));
vi.mock('../self-secrets', () => ({
  listAppDeclaredSecrets: holder.list, ensureAppDeclaredSecrets: vi.fn(),
  rotateAppDeclaredSecret: vi.fn(), revokeAppDeclaredSecret: vi.fn(), setAppDeclaredSecret: vi.fn(),
}));
vi.mock('@/src/lib/github/org-provisioning', () => ({}));
vi.mock('@/src/lib/vault/authorization', () => ({}));
vi.mock('@/src/lib/notify/operator-approvals', () => ({}));
vi.mock('../secret-staging', () => ({}));
import { listOperatorAppSecrets } from '../secrets-operator';

let client: PGlite;
const at = '2026-10-14T00:00:00.000Z';
const expires = '2026-10-14T00:15:00.000Z';
const did = (slug: string) => `did:imajin:fixture-${slug}`;

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec(`
    CREATE SCHEMA registry; CREATE SCHEMA kernel; CREATE SCHEMA operator;
    CREATE TABLE registry.apps (
      app_did text PRIMARY KEY, slug text, name text, status text,
      owner_did text, created_at timestamptz
    );
    CREATE TABLE kernel.app_provisions (
      slug text PRIMARY KEY, app_did text, status text, created_at timestamptz, registered_at timestamptz
    );
    CREATE TABLE kernel.app_signing_key_claims (
      app_did text, status text, expires_at timestamptz, claimed_at timestamptz,
      claimed_by_host text, bootstrap_key_revoked_at timestamptz, created_at timestamptz
    );
    CREATE TABLE operator.approvals (
      source text, kind text, status text, detail jsonb, decision jsonb,
      signer_did text, created_at timestamptz
    );
  `);
  holder.db = drizzle(client, { schema: { registryApps, appProvisions, appSigningKeyClaims, operatorApprovals } });
  await seedApps();
  await seedClaims();
  await seedApprovals();
  holder.list.mockImplementation(secretTimeline);
}, 30_000);
afterAll(async () => { await client?.close(); });

async function seedApps() {
  for (const slug of ['claimed', 'awaiting', 'legacy-claim', 'revoked-key', 'no-code', 'dcr', 'legacy-das', 'first-party', 'retired']) {
    await client.query('INSERT INTO registry.apps VALUES ($1,$2,$2,$3,$4,$5)', [
      did(slug), slug, slug === 'retired' ? 'revoked' : 'active',
      slug === 'legacy-claim' ? ' ' : did('registrar'), slug === 'legacy-claim' ? null : at,
    ]);
  }
  for (const slug of ['claimed', 'awaiting', 'revoked-key', 'no-code', 'retired', 'orphan']) {
    await client.query('INSERT INTO kernel.app_provisions VALUES ($1,$2,$3,$4,$5)', [
      slug, slug === 'orphan' ? null : did(slug), slug === 'orphan' ? 'failed' : 'succeeded', at, at,
    ]);
  }
}

async function seedClaims() {
  for (const [slug, status, revoked] of [
    ['claimed', 'claimed', null], ['awaiting', 'pending', null], ['legacy-claim', 'expired', null],
    ['revoked-key', 'claimed', at], ['retired', 'claimed', null],
  ]) {
    await client.query('INSERT INTO kernel.app_signing_key_claims VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      did(slug!), status, expires, status === 'claimed' ? at : null,
      status === 'claimed' ? 'fixture-host' : null, revoked, at,
    ]);
  }
  // A newer reissue supersedes expiry, never the original provision attribution.
  await client.query('INSERT INTO kernel.app_signing_key_claims VALUES ($1,$2,$3,NULL,NULL,NULL,$4)', [
    did('awaiting'), 'pending', '2026-10-15T00:15:00Z', '2026-10-15T00:00:00Z',
  ]);
}

async function seedApprovals() {
  for (const [source, kind, status, decision, extra] of [
    ['other', 'apps:provision', 'applied', 'approve', {}],
    ['apps', 'apps:service-scopes', 'applied', 'approve', {}],
    ['apps', 'apps:provision', 'denied', 'reject', {}],
    ['apps', 'apps:provision', 'approved', 'approve', {}],
    ['apps', 'apps:provision', 'applied', 'approve', { reissueClaim: true }],
    ['apps', 'apps:provision', 'applied', 'approve', {}],
  ] as const) {
    const valid = source === 'apps' && kind === 'apps:provision' && status === 'applied' && !('reissueClaim' in extra);
    await client.query('INSERT INTO operator.approvals VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      source, kind, status, JSON.stringify({ slug: 'claimed', ...extra }),
      JSON.stringify({ payload: { decision, decidedBy: valid ? did('approver') : did('wrong-approver') } }),
      valid ? did('proposer') : did('wrong-proposer'), at,
    ]);
  }
}

async function secretTimeline(appDid: string) {
  return appDid === did('claimed') ? [{
    name: 'SESSION_SECRET', kind: 'random-32B', status: 'active', value: 'OBVIOUSLY_FAKE_NOT_A_SECRET',
    timeline: [
      { phase: 'fetched', at: '2026-10-14T04:00:00Z' },
      { phase: 'rotated', at: '2026-10-14T08:00:00Z' },
      { phase: 'fetched', at: '2026-10-14T02:00:00Z' },
    ],
  }, {
    name: 'DATABASE_URL', kind: 'operator-supplied', status: 'active',
    timeline: [{ phase: 'fetched', at: '2026-10-14T06:00:00Z' }],
  }] : [];
}

describe('self-secret inventory against real Postgres semantics', () => {
  it('excludes registry-only DCR, legacy DAS and first-party seeds, retaining both ledger paths', async () => {
    const apps = await listOperatorAppSecrets();
    expect(apps.map((app) => app.slug).sort()).toEqual([
      'awaiting', 'claimed', 'legacy-claim', 'no-code', 'orphan', 'retired', 'revoked-key',
    ]);
    for (const slug of ['dcr', 'legacy-das', 'first-party']) {
      expect(apps.some((app) => app.appDid === did(slug))).toBe(false);
      expect(holder.list).not.toHaveBeenCalledWith(did(slug));
    }
    expect(apps.filter((app) => app.slug === 'claimed')).toHaveLength(1);
  });
  it('projects original successful provision actors and the latest fetched event across secrets', async () => {
    const app = (await listOperatorAppSecrets()).find((row) => row.slug === 'claimed')!;
    expect(app.claimed).toBe(true);
    expect(app.provenance).toEqual({
      created: { at, by: did('registrar') },
      provisioned: { at, proposedBy: did('proposer'), approvedBy: did('approver') },
      claimed: { at, by: 'fixture-host' },
      lastSeen: { at: '2026-10-14T06:00:00Z', by: did('claimed') },
    });
    expect(JSON.stringify(app)).not.toContain('OBVIOUSLY_FAKE_NOT_A_SECRET');
  });
  it('retains pending, expired and no-code apps with latest expiry, never treating revoked bindings as claimed', async () => {
    const apps = await listOperatorAppSecrets();
    const awaiting = apps.find((app) => app.slug === 'awaiting')!;
    expect(awaiting).toMatchObject({ claimed: false, claimExpiresAt: '2026-10-15T00:15:00.000Z' });
    const legacy = apps.find((app) => app.slug === 'legacy-claim')!;
    expect(legacy).toMatchObject({ claimed: false, claimExpiresAt: expires });
    expect(legacy.provenance.created).toEqual({ at: null, by: null });
    expect(legacy.provenance.provisioned).toEqual({ at: null, proposedBy: null, approvedBy: null });
    expect(apps.find((app) => app.slug === 'revoked-key')).toMatchObject({ claimed: false, claimExpiresAt: null });
    expect(apps.find((app) => app.slug === 'no-code')).toMatchObject({ claimed: false, claimExpiresAt: null });
  });
  it('does not read secret metadata for inactive or orphan provisions and never invents identities', async () => {
    const apps = await listOperatorAppSecrets();
    const orphan = apps.find((app) => app.slug === 'orphan')!;
    expect(orphan).toMatchObject({ appDid: null, active: false, claimed: false, secrets: [] });
    expect(orphan.provenance).toEqual({
      created: { at: null, by: null }, provisioned: { at, proposedBy: null, approvedBy: null },
      claimed: { at: null, by: null }, lastSeen: { at: null, by: null },
    });
    expect(holder.list).not.toHaveBeenCalledWith(did('retired'));
  });
  it('marks failed and abandoned pending provisions with no live code as failed, but preserves a live pending claim', async () => {
    for (const [slug, status, code] of [
      ['failed-fixture', 'failed', false], ['abandoned-fixture', 'pending', false],
      ['live-fixture', 'pending', true],
    ] as const) {
      await client.query('INSERT INTO kernel.app_provisions VALUES ($1,$2,$3,$4,$4)', [slug, did(slug), status, at]);
      if (code) await client.query('INSERT INTO kernel.app_signing_key_claims VALUES ($1,$2,$3,NULL,NULL,NULL,$4)', [
        did(slug), 'pending', '2099-01-01T00:00:00Z', at,
      ]);
    }
    const apps = await listOperatorAppSecrets();
    expect(apps.find(app => app.slug === 'failed-fixture')?.provisionFailed).toBe(true);
    expect(apps.find(app => app.slug === 'abandoned-fixture')?.provisionFailed).toBe(true);
    expect(apps.find(app => app.slug === 'live-fixture')?.provisionFailed).toBe(false);
  });

});
