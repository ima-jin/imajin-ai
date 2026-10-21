/**
 * Real PostgreSQL, not PGlite/a serialized transaction mock. Opt in with
 * CONSENT_TEST_DATABASE_URL pointing to a LOCAL disposable PostgreSQL admin
 * database whose user may CREATE DATABASE. This suite creates its own randomly
 * named database, never mutates the supplied database, and drops its DB on exit.
 *
 * CONSENT_TEST_DATABASE_URL=postgresql://localhost:55438/postgres \
 *   pnpm exec vitest run apps/kernel/src/lib/auth/__tests__/upsert-app-authorization.postgres.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import * as authCrypto from '../../../../../../packages/auth/src/crypto';
import { canonicalize } from '../../../../../../packages/auth/src/sign';
import { attestations, channelLinks } from '@/src/db/schemas/auth';
import { oauthRefreshTokens } from '@/src/db/schemas/oauth';

const h = vi.hoisted(() => ({
  database: undefined as PostgresJsDatabase | undefined,
  failSigningType: '',
}));
vi.mock('@/src/db', async () => {
  const auth = await import('@/src/db/schemas/auth');
  const oauth = await import('@/src/db/schemas/oauth');
  return {
    ...auth, ...oauth,
    db: {
      transaction: (...args: Parameters<PostgresJsDatabase['transaction']>) => h.database!.transaction(...args),
    },
  };
});
vi.mock('@imajin/auth', async () => {
  const crypto = await import('../../../../../../packages/auth/src/crypto');
  const { canonicalize } = await import('../../../../../../packages/auth/src/sign');
  return {
    canonicalize,
    crypto: {
      ...crypto,
      signSync: (message: string, privateKey: string) => {
        if (JSON.parse(message).type === h.failSigningType) throw new Error('injected signing failure');
        return crypto.signSync(message, privateKey);
      },
    },
  };
});

import { upsertAppAuthorization, revokeAppAuthorization } from '../upsert-app-authorization';

// Scratch DDL derives columns/defaults from production schema, not a new migration.
// Foreign keys to unrelated domain tables aren't needed for this isolated seam.
function createTable(table: PgTable): string {
  const config = getTableConfig(table);
  const columns = config.columns.map(column => {
    let definition = `"${column.name}" ${column.getSQLType()}`;
    if (column.primary) definition += ' PRIMARY KEY';
    if (column.notNull) definition += ' NOT NULL';
    if (column.default !== undefined) {
      const value = column.default;
      const literal = value instanceof SQL
        ? new PgDialect().sqlToQuery(value).sql
        : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
      definition += ` DEFAULT ${literal}`;
    }
    return definition;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(', ')})`;
}

const adminUrl = process.env.CONSENT_TEST_DATABASE_URL;
const databaseName = `consent_test_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof postgres>;
let client: ReturnType<typeof postgres>;
const keypair = authCrypto.generateKeypair();
const consent = {
  ownerDid: 'did:imajin:owner', appDid: 'did:imajin:app', appId: 'app_test',
  callbackUrl: 'https://app.example.test/callback', scopes: ['media:read'],
  privateKey: keypair.privateKey,
};
const projectionWhere = and(eq(channelLinks.channel, 'app'), eq(channelLinks.channelUid, consent.ownerDid),
  eq(channelLinks.appDid, consent.appDid));
async function seed(id: string, scopes = ['media:read'], extra: Partial<typeof attestations.$inferInsert> = {}) {
  await h.database!.insert(attestations).values({
    id, issuerDid: consent.ownerDid, subjectDid: consent.appDid, type: 'app.authorized',
    signature: 'historical-fixture', payload: { scopes }, issuedAt: new Date('2026-01-01'), ...extra,
  });
  await h.database!.insert(oauthRefreshTokens).values({
    id: `refresh_${id}`, tokenHash: `hash_${id}`, clientId: consent.appId,
    userDid: consent.ownerDid, scope: scopes.join(' '), attestationId: id,
    expiresAt: new Date('2099-01-01'),
  });
}
async function live() {
  const rows = await h.database!.select().from(attestations).where(and(
    eq(attestations.type, 'app.authorized'), eq(attestations.issuerDid, consent.ownerDid),
    eq(attestations.subjectDid, consent.appDid), isNull(attestations.revokedAt),
  ));
  return rows.filter(row => row.expiresAt === null || row.expiresAt.getTime() > Date.now());
}
async function projection() {
  return (await h.database!.select().from(channelLinks).where(projectionWhere))[0];
}
async function state() {
  return {
    grants: await client`SELECT * FROM auth.attestations ORDER BY id`,
    tokens: await client`SELECT * FROM auth.oauth_refresh_tokens ORDER BY id`,
    links: await client`SELECT * FROM auth.channel_links ORDER BY id`,
  };
}
async function verifyProofs(ids: string[]) {
  const proofs = await h.database!.select().from(attestations).where(eq(attestations.type, 'app.revoked'));
  expect(proofs.map(row => row.contextId).sort()).toEqual([...ids].sort());
  for (const proof of proofs) {
    expect(proof).toMatchObject({
      issuerDid: consent.ownerDid, subjectDid: consent.appDid, contextType: 'attestation',
      payload: { revokedAttestationId: proof.contextId, appDid: consent.appDid },
    });
    expect(authCrypto.verifySync(proof.signature, canonicalize({
      subject_did: proof.subjectDid, type: proof.type, context_id: proof.contextId,
      context_type: proof.contextType, payload: proof.payload, issued_at: proof.issuedAt.getTime(),
    }), keypair.publicKey)).toBe(true);
  }
}
async function waitForBlocked(count: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await admin`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = ${databaseName} AND wait_event = 'advisory'
    `;
    if (rows[0].count >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} real PostgreSQL sessions waiting on the pair advisory lock`);
}

describe.skipIf(!adminUrl)('shared app consent — disposable real PostgreSQL (#3008)', () => {
  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('CONSENT_TEST_DATABASE_URL must target a local disposable PostgreSQL server');
    }
    admin = postgres(adminUrl!, { max: 2, connect_timeout: 5 });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 6, connect_timeout: 5, connection: { statement_timeout: 10000 } });
    h.database = drizzle(client);
    await client.unsafe('CREATE SCHEMA auth');
    for (const table of [attestations, channelLinks, oauthRefreshTokens]) await client.unsafe(createTable(table));
    await client.unsafe('CREATE UNIQUE INDEX uniq_channel_links_pair ON auth.channel_links (channel, channel_uid, app_did)');
  }, 20000);
  afterAll(async () => {
    await client?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    h.failSigningType = '';
    await client.unsafe('TRUNCATE auth.attestations, auth.channel_links, auth.oauth_refresh_tokens');
  });

  it.each([false, true])('chooses newest issuedAt regardless of physical insertion order (reverse=%s)', async reverse => {
    const rows = [
      ['att_newest', new Date('2026-03-01')],
      ['att_oldest', new Date('2026-01-01')],
      ['att_middle', new Date('2026-02-01')],
    ] as const;
    for (const [id, issuedAt] of reverse ? [...rows].reverse() : rows) await seed(id, ['media:read'], { issuedAt });
    expect(await upsertAppAuthorization(consent)).toBe('att_newest');
    expect((await live()).map(row => row.id)).toEqual(['att_newest']);
    await verifyProofs(['att_oldest', 'att_middle']);
  });

  it('breaks equal timestamp ties deterministically by descending ID', async () => {
    await seed('att_z');
    await seed('att_a');
    expect(await upsertAppAuthorization(consent)).toBe('att_z');
    await verifyProofs(['att_a']);
  });

  it('reuses set-equivalent scopes, removes all duplicates, and repairs a revoked projection', async () => {
    await seed('att_old');
    await seed('att_new', ['media:read', 'profile:read', 'media:read'], { issuedAt: new Date('2026-02-01') });
    await h.database!.insert(channelLinks).values({
      id: 'link', channel: 'app', channelUid: consent.ownerDid, did: consent.ownerDid,
      appDid: consent.appDid, scopes: [], status: 'revoked', revokedAt: new Date(),
    });
    const scopes = ['profile:read', 'media:read', 'profile:read'];
    expect(await upsertAppAuthorization({ ...consent, scopes })).toBe('att_new');
    expect(await projection()).toMatchObject({ scopes: ['profile:read', 'media:read'], status: 'active', revokedAt: null });
    expect((await live()).map(row => row.id)).toEqual(['att_new']);
    await verifyProofs(['att_old']);
  });

  it('changed scopes revoke EVERY live row with valid signed proof and invalidate every refresh chain', async () => {
    await seed('first', ['media:read']);
    await seed('second', ['profile:read'], { issuedAt: new Date('2026-02-01') });
    await seed('third', ['profile:read'], { issuedAt: new Date('2026-03-01') });
    await seed('unrelated', ['profile:read'], { issuerDid: 'did:imajin:other-owner' });
    const id = await upsertAppAuthorization(consent);
    expect((await live()).map(row => row.id)).toEqual([id]);
    await verifyProofs(['first', 'second', 'third']);
    const tokens = await h.database!.select().from(oauthRefreshTokens);
    for (const token of tokens) expect(Boolean(token.revokedAt)).toBe(token.attestationId !== 'unrelated');
    expect(await projection()).toMatchObject({ scopes: ['media:read'], status: 'active' });
    const [fresh] = await live();
    expect(authCrypto.verifySync(fresh.signature, canonicalize({
      subject_did: fresh.subjectDid, type: fresh.type, context_id: fresh.contextId,
      context_type: fresh.contextType, payload: fresh.payload, issued_at: fresh.issuedAt.getTime(),
    }), keypair.publicKey)).toBe(true);
  });

  it('supersedes a live legacy row whose nullable attestation_status is NULL', async () => {
    await seed('legacy-null-status', ['profile:read'], { attestationStatus: null });
    const id = await upsertAppAuthorization(consent);
    expect((await live()).map(row => row.id)).toEqual([id]);
    await verifyProofs(['legacy-null-status']);
    const [refresh] = await h.database!.select().from(oauthRefreshTokens);
    expect(refresh.revokedAt).toBeInstanceOf(Date);
  });

  it('does not revoke a bilateral row or commit a second grant when revocation is refused', async () => {
    await seed('protected', ['profile:read'], { attestationStatus: 'bilateral' });
    const before = await state();
    await expect(upsertAppAuthorization(consent)).rejects.toThrow('retry consent');
    expect(await state()).toEqual(before);
  });

  it('never reuses expired or revoked rows, even if those rows are newest', async () => {
    await seed('expired', ['media:read'], { expiresAt: new Date(0), issuedAt: new Date('2099-01-01') });
    await seed('revoked', ['media:read'], { revokedAt: new Date(), issuedAt: new Date('2099-01-02') });
    const id = await upsertAppAuthorization(consent);
    expect(['expired', 'revoked']).not.toContain(id);
    expect((await live()).map(row => row.id)).toEqual([id]);
    await verifyProofs([]);
  });

  it('surplus revoke preserves survivor scopes and final revoke disconnects the projection', async () => {
    await seed('older', ['profile:read']);
    await seed('newer', ['media:read'], { issuedAt: new Date('2026-02-01') });
    const params = { ownerDid: consent.ownerDid, appDid: consent.appDid, privateKey: consent.privateKey };
    expect(await revokeAppAuthorization({ ...params, attestationId: 'older' })).toMatchObject({ revoked: true });
    expect(await projection()).toMatchObject({ scopes: ['media:read'], status: 'active' });
    expect(await revokeAppAuthorization({ ...params, attestationId: 'newer' })).toMatchObject({ revoked: true });
    expect(await projection()).toMatchObject({ status: 'revoked', revokedAt: expect.any(Date) });
    const before = await state();
    expect(await revokeAppAuthorization({ ...params, attestationId: 'newer' })).toEqual({ revoked: false });
    expect(await state()).toEqual(before);
    await verifyProofs(['older', 'newer']);
  });

  it.each(['app.revoked', 'app.authorized'])('rolls back grants, proofs, refresh invalidation and projection when signing %s fails', async type => {
    await seed('old', ['profile:read']);
    const before = await state();
    h.failSigningType = type;
    await expect(upsertAppAuthorization(consent)).rejects.toThrow('injected signing failure');
    expect(await state()).toEqual(before);
  });

  it('rolls back all writes when the real projection INSERT fails', async () => {
    await seed('old', ['profile:read']);
    const before = await state();
    await client.unsafe("ALTER TABLE auth.channel_links ADD CONSTRAINT injected_failure CHECK (status <> 'active')");
    try {
      await expect(upsertAppAuthorization(consent)).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally {
      await client.unsafe('ALTER TABLE auth.channel_links DROP CONSTRAINT injected_failure');
    }
  });

  it('rolls back an explicit revoke if disconnecting the projection fails', async () => {
    const id = await upsertAppAuthorization(consent);
    await client.unsafe("ALTER TABLE auth.channel_links ADD CONSTRAINT injected_failure CHECK (status <> 'revoked')");
    const before = await state();
    try {
      await expect(revokeAppAuthorization({
        ownerDid: consent.ownerDid, appDid: consent.appDid, privateKey: consent.privateKey, attestationId: id,
      })).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally {
      await client.unsafe('ALTER TABLE auth.channel_links DROP CONSTRAINT injected_failure');
    }
  });

  it.each([false, true])('two contending requests on an EMPTY pair leave exactly one live grant (changed scopes=%s)', async changed => {
    // Hold the exact pair lock from a third connection. Both helper requests
    // must visibly block in pg_stat_activity before release: this cannot pass
    // merely because a JavaScript transaction mock serializes callbacks.
    const blocker = await client.reserve();
    await blocker`BEGIN`;
    await blocker`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['app.authorized', consent.ownerDid, consent.appDid])}, 0))`;
    const first = upsertAppAuthorization(consent);
    const second = upsertAppAuthorization({
      ...consent, scopes: changed ? ['profile:read'] : ['media:read', 'media:read'],
    });
    try {
      await waitForBlocked(2);
    } finally {
      await blocker`COMMIT`;
      blocker.release();
    }
    const ids = await Promise.all([first, second]);
    const survivors = await live();
    expect(survivors).toHaveLength(1);
    expect(ids).toContain(survivors[0].id);
    expect(new Set(ids).size).toBe(changed ? 2 : 1);
    const proofs = await h.database!.select().from(attestations).where(eq(attestations.type, 'app.revoked'));
    expect(proofs).toHaveLength(changed ? 1 : 0);
    expect(await projection()).toMatchObject({ status: 'active', scopes: (survivors[0].payload as { scopes: string[] }).scopes });
  }, 15000);
});
