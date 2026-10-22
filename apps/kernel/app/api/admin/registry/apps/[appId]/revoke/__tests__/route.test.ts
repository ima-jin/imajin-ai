import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { attestations } from '@/src/db/schemas/auth';
import * as authCrypto from '../../../../../../../../../../packages/auth/src/crypto';
import { canonicalize } from '../../../../../../../../../../packages/auth/src/sign';

const mocks = vi.hoisted(() => ({
  database: null as unknown, auth: vi.fn(), nodeInfo: vi.fn(), failSigning: false,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/auth'),
  db: new Proxy({}, { get: (_target, key) => {
    const database = mocks.database as Record<string | symbol, unknown>;
    const value = database[key];
    return typeof value === 'function' ? value.bind(database) : value;
  } }),
}));
vi.mock('@imajin/auth', async () => {
  const crypto = await import('../../../../../../../../../../packages/auth/src/crypto');
  const { canonicalize } = await import('../../../../../../../../../../packages/auth/src/sign');
  return {
    requireAuth: mocks.auth, canonicalize,
    crypto: { signSync: (message: string, key: string) => {
      if (mocks.failSigning) throw new Error('private signing detail');
      return crypto.signSync(message, key);
    } },
  };
});
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: mocks.nodeInfo }));
import * as route from '../route';

const APP_ID = 'app_fixture';
const OPERATOR = 'did:imajin:operator';
const APP_DID = 'did:imajin:app-fixture';
const keypair = authCrypto.generateKeypair();
let client: PGlite;
function revoke(appId = APP_ID) {
  return route.POST(new Request(`https://fixture.invalid/api/admin/registry/apps/${appId}/revoke`, {
    method: 'POST',
  }) as Parameters<typeof route.POST>[0], { params: Promise.resolve({ appId }) });
}
async function state() {
  return {
    apps: (await client.query('SELECT * FROM registry.apps ORDER BY id')).rows,
    attestations: (await client.query('SELECT * FROM auth.attestations ORDER BY id')).rows,
  };
}
beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  await client.exec(`
    CREATE SCHEMA registry; CREATE SCHEMA auth;
    CREATE TABLE registry.apps (id text PRIMARY KEY, app_did text, status text,
      revoked_at timestamptz, updated_at timestamptz);
  `);
  const columns = getTableConfig(attestations).columns
    .map(column => `"${column.name}" ${column.getSQLType()}`);
  await client.exec(`CREATE TABLE auth.attestations (${columns.join(', ')})`);
  mocks.database = drizzle(client);
}, 30_000);
afterAll(async () => { await client?.close(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.failSigning = false;
  mocks.auth.mockResolvedValue({ identity: { id: OPERATOR } });
  mocks.nodeInfo.mockResolvedValue({ nodeOperatorDid: OPERATOR });
  vi.stubEnv('AUTH_PRIVATE_KEY', keypair.privateKey);
  await client.exec('TRUNCATE registry.apps, auth.attestations');
  await client.query('INSERT INTO registry.apps (id,app_did,status) VALUES ($1,$2,$3)', [APP_ID, APP_DID, 'active']);
});

describe('existing POST /api/admin/registry/apps/:appId/revoke', () => {
  it('refuses unauthenticated requests without reading or mutating registry history', async () => {
    mocks.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    const before = await state();
    expect((await revoke()).status).toBe(401);
    expect(mocks.nodeInfo).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
  it.each([
    { id: 'did:imajin:non-operator' },
    { id: 'did:imajin:agent', actingFor: OPERATOR },
    { id: OPERATOR, actingFor: OPERATOR },
    { id: 'did:imajin:node', actingAs: OPERATOR },
  ])('refuses non-operator or delegated identity %j', async identity => {
    mocks.auth.mockResolvedValue({ identity });
    const before = await state();
    expect((await revoke()).status).toBe(403);
    expect(await state()).toEqual(before);
  });
  it('fails closed without a configured operator', async () => {
    mocks.nodeInfo.mockResolvedValue(null);
    const before = await state();
    expect((await revoke()).status).toBe(403);
    expect(await state()).toEqual(before);
  });
  it('404s an unknown id without any writes', async () => {
    const before = await state();
    expect((await revoke('missing')).status).toBe(404);
    expect(await state()).toEqual(before);
  });
  it('retains the app, changes status, and commits a verifiable receipt naming the operator', async () => {
    const response = await revoke();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, attestationId: expect.stringMatching(/^att_/) });
    const result = await state();
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]).toMatchObject({ id: APP_ID, app_did: APP_DID, status: 'revoked' });
    expect(result.attestations).toHaveLength(1);
    const proof = result.attestations[0] as {
      id: string; signature: string; issued_at: Date; payload: unknown;
    };
    expect(proof).toMatchObject({
      id: body.attestationId, issuer_did: OPERATOR, subject_did: APP_DID,
      type: 'registry.app.revoked', context_id: APP_ID, context_type: 'registry_app',
      payload: { appId: APP_ID }, issued_at: result.apps[0].revoked_at,
    });
    expect(authCrypto.verifySync(proof.signature, canonicalize({
      subject_did: APP_DID, type: 'registry.app.revoked', context_id: APP_ID,
      context_type: 'registry_app', payload: proof.payload, issued_at: proof.issued_at.getTime(),
    }), keypair.publicKey)).toBe(true);
    expect(route).not.toHaveProperty('DELETE');
  });
  it('is idempotent without a second receipt or a changed timestamp', async () => {
    await revoke();
    const before = await state();
    expect(await (await revoke()).json()).toEqual({ ok: true, alreadyRevoked: true });
    expect(await state()).toEqual(before);
  });
  it('creates exactly one receipt for simultaneous Clear requests', async () => {
    const responses = await Promise.all([revoke(), revoke()]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect((await state()).attestations).toHaveLength(1);
  });
  it('refuses missing signing configuration without changing state', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    const before = await state();
    expect((await revoke()).status).toBe(503);
    expect(await state()).toEqual(before);
  });
  it('rolls back the status change if signing fails and redacts the failure', async () => {
    mocks.failSigning = true;
    const before = await state();
    const response = await revoke();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Could not clear registered app' });
    expect(await state()).toEqual(before);
  });
  it('rolls back the status change if the receipt cannot be stored', async () => {
    await client.exec("ALTER TABLE auth.attestations ADD CONSTRAINT reject_receipt CHECK (type <> 'registry.app.revoked')");
    try {
      const before = await state();
      expect((await revoke()).status).toBe(503);
      expect(await state()).toEqual(before);
    } finally {
      await client.exec('ALTER TABLE auth.attestations DROP CONSTRAINT reject_receipt');
    }
  });
});
