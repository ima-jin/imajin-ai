/**
 * Unconditional, local-only PostgreSQL integration (#2976). PGlite is the
 * project's embedded Postgres engine: no DATABASE_URL or live node is used.
 * Normal Vitest CI includes app test directories without an opt-in flag.
 * Only session lookup and unrelated outbound effects/executors are mocked;
 * registration, discovery SQL, proposals, decision verification/execution,
 * app proof-of-possession and JWT mint/verification run their real paths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { eq, SQL } from 'drizzle-orm';
import { canonicalize, crypto as authCrypto, type Identity } from '@imajin/auth';
import { registryApps } from '@/src/db/schemas/registry';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { countersignedMessage } from '@/src/lib/notify/operator-countersign-fields';
import { verifyAppToken } from '@/src/lib/auth/jwt';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { GET, POST as propose } from '../route';
import { POST as register } from '@/app/api/registry/apps/route';
import { POST as mint } from '@/app/auth/api/apps/token/service/route';
import { POST as decide } from '@/app/jin/api/operator-approvals/[proposalId]/decision/route';

const state = vi.hoisted(() => ({
  database: null as unknown,
  requireAuth: vi.fn(),
  provision: vi.fn(),
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/db', async () => {
  const registry = await import('@/src/db/schemas/registry');
  const approvals = await import('@/src/db/schemas/operator-approvals');
  const auth = await import('@/src/db/schemas/auth');
  return { ...registry, ...approvals, identities: auth.identities, get db() { return state.database; } };
});
vi.mock('@imajin/auth', async () => ({
  ...await vi.importActual<typeof import('@imajin/auth')>('@imajin/auth'),
  requireAuth: state.requireAuth,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  withLogger: (_service: string, handler: unknown) => handler,
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeSelfInfo: async () => ({ nodeOperatorDid: 'did:imajin:operator' }),
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({
    privateKeyHex: '11'.repeat(32), senderPubkey: authCrypto.getPublicKey('11'.repeat(32)),
  }),
}));
vi.mock('@imajin/bus', () => ({ publish: state.publish }));
vi.mock('@/src/lib/notify/web-push', () => ({ pushWebNotificationToOperator: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/apps/approvals-execution', () => ({
  APPS_SOURCE: 'apps', executeAppsProvisionApproval: state.provision,
}));
vi.mock('@/src/lib/vault/approvals-execution', () => ({ executeVaultApproval: vi.fn() }));
vi.mock('@/src/lib/access/approvals-execution', () => ({ executeAccessApproval: vi.fn() }));
vi.mock('@/src/lib/github/approvals-execution', () => ({ GITHUB_SOURCE: 'github', executeGithubApproval: vi.fn() }));
vi.mock('@/src/lib/apps/featured', () => ({ executeAppsFeaturedApproval: vi.fn() }));
vi.mock('@/src/lib/apps/secrets-operator', () => ({ executeAppSecretsApproval: vi.fn() }));
vi.mock('@/src/lib/apps/secret-staging', () => ({ discardAppSecretForProposal: vi.fn() }));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const OWNER = 'did:imajin:developer';
const OPERATOR = 'did:imajin:operator';
const operatorKey = '22'.repeat(32);
const appKey = '33'.repeat(32);
const appPublicKey = authCrypto.getPublicKey(appKey);
const APP_DID = didFromPublicKey(appPublicKey);
let engine: PGlite;
let database: ReturnType<typeof drizzle>;

// Materialize the actual Drizzle table columns/defaults, not a query-chain fake.
// There is deliberately no kernel.app_provisions table in this database.
function createTable(table: typeof registryApps | typeof operatorApprovals) {
  const config = getTableConfig(table);
  const dialect = new PgDialect();
  const columns = config.columns.map((column) => {
    let defaultSql = '';
    if (column.default !== undefined) {
      const value = column.default;
      const literal = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const expression = value instanceof SQL
        ? dialect.sqlToQuery(value).sql
        : `'${literal.replaceAll("'", "''")}'`;
      defaultSql = ` DEFAULT ${expression}`;
    }
    return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
  });
  return `CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(',')})`;
}

function authenticate(id: string = OPERATOR, overlay: Partial<Identity> = {}) {
  state.requireAuth.mockResolvedValue({ identity: { id, scope: 'actor', subtype: 'human', ...overlay } });
}

function request(path: string, body?: unknown) {
  return new Request(`https://kernel.test${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as never;
}

async function mintedScopes(expected: string[]) {
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const response = await mint(request('/auth/api/apps/token/service', {
    appDid: APP_DID, nonce, timestamp,
    signature: authCrypto.signSync(`${APP_DID}:${nonce}:${timestamp}`, appKey),
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.scopes).toEqual(expected);
  expect(await verifyAppToken(body.token)).toMatchObject({
    sub: APP_DID, azp: APP_DID, scope: expected.join(' '), isServiceToken: true, attestationId: '',
  });
}

async function proposal(scopes: string[], action: 'grant' | 'revoke' = 'grant') {
  authenticate(OWNER);
  const response = await propose(request('/api/apps/service-scopes', { appDid: APP_DID, scopes, action }));
  expect(response.status).toBe(201);
  const { proposalId } = await response.json();
  const [row] = await database.select().from(operatorApprovals).where(eq(operatorApprovals.proposalId, proposalId));
  expect(row.proposalId).toBe(proposalId);
  expect(row.status).toBe('pending');
  return row;
}

async function decision(row: typeof operatorApprovals.$inferSelect, choice: 'approve' | 'reject', key = operatorKey) {
  authenticate();
  const fields = { contentHash: row.contentHash!, decision: choice, decidedAt: new Date().toISOString() };
  return decide(request(`/jin/api/operator-approvals/${row.proposalId}/decision`, {
    decision: choice, decidedAt: fields.decidedAt,
    operatorSignature: {
      keyId: authCrypto.getPublicKey(key), alg: 'ed25519',
      sig: authCrypto.signSync(countersignedMessage(fields), key),
    },
  }), { params: Promise.resolve({ proposalId: row.proposalId }) });
}

beforeAll(async () => {
  engine = new PGlite();
  await engine.waitReady;
  await engine.exec('CREATE SCHEMA registry; CREATE SCHEMA operator; CREATE SCHEMA auth;');
  await engine.exec(createTable(registryApps));
  await engine.exec(createTable(operatorApprovals));
  await engine.exec('CREATE TABLE auth.identities (id text PRIMARY KEY, public_key text, scope text, tier text)');
  database = drizzle(engine);
  state.database = database;
});

beforeEach(async () => {
  vi.clearAllMocks();
  await engine.exec('TRUNCATE registry.apps, operator.approvals, auth.identities');
  await engine.query("INSERT INTO auth.identities VALUES ($1,$2,'actor','established')",
    [OPERATOR, authCrypto.getPublicKey(operatorKey)]);
  authenticate(OWNER);
  const response = await register(request('/api/registry/apps', {
    name: 'Self-registered partner', callbackUrl: 'https://partner.test/callback',
    publicKey: appPublicKey, requestedScopes: ['identity:write', 'identity:read'],
    approvedServiceScopes: ['identity:write'], // an app cannot self-grant this
  }));
  expect(response.status).toBe(201);
  const app = await response.json();
  expect(app).toMatchObject({ appDid: APP_DID, slug: null, tier: 'third_party', approvedServiceScopes: [] });
});

afterAll(async () => engine?.close());

describe('registered-app service-scope discovery against PostgreSQL', () => {
  it('discovers a real self-registration without provisioning and projects only scope metadata', async () => {
    authenticate();
    const response = await GET(request('/api/apps/service-scopes'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      apps: [{
        appDid: APP_DID, name: 'Self-registered partner', status: 'active',
        requestedScopes: ['identity:read', 'identity:write'], approvedServiceScopes: [],
        approvalId: null, approvedAt: null,
      }], nextCursor: null,
    });
    expect(state.provision).not.toHaveBeenCalled();
  });

  it('paginates actual SQL over more than 50 apps, including inactive apps and malformed stored scope sets', async () => {
    await database.insert(registryApps).values(Array.from({ length: 53 }, (_, index) => ({
      id: `fixture-${index}`, appDid: `did:imajin:fixture-${String(index).padStart(3, '0')}`,
      ownerDid: OWNER, name: `Fixture ${index}`, publicKey: appPublicKey,
      callbackUrl: 'https://partner.test/callback', status: index === 52 ? 'revoked' : 'active',
      requestedScopes: ['identity:write', 'identity:read', 'identity:write'],
    })));
    await engine.query("UPDATE registry.apps SET requested_scopes = '\"malformed\"'::jsonb WHERE id = 'fixture-52'");
    authenticate();
    const first = await (await GET(request('/api/apps/service-scopes'))).json();
    expect(first.apps).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await (await GET(request(`/api/apps/service-scopes?cursor=${encodeURIComponent(first.nextCursor)}`))).json();
    expect(second.apps).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    const combined = [...first.apps, ...second.apps];
    const dids = combined.map((app: { appDid: string }) => app.appDid);
    expect(new Set(dids).size).toBe(54);
    expect(dids).toEqual([...dids].sort());
    expect(combined.find((app: { status: string }) => app.status === 'revoked')).toMatchObject({
      requestedScopes: [], approvedServiceScopes: [],
    });
  });

  it.each([
    [OWNER, {}], ['did:imajin:stranger', {}], [OPERATOR, { actingFor: OWNER }],
    [OPERATOR, { actingAs: OWNER, actingAsRole: 'owner' }],
  ])('refuses discovery as %s with overlay %j', async (id, overlay) => {
    authenticate(id, overlay as Partial<Identity>);
    const select = vi.spyOn(database, 'select');
    const response = await GET(request('/api/apps/service-scopes'));
    expect(response.status).toBe(403);
    expect(select).not.toHaveBeenCalled();
    select.mockRestore();
  });

  it('refuses anonymous discovery and retains the owner targeted read', async () => {
    state.requireAuth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await GET(request('/api/apps/service-scopes'))).status).toBe(401);
    authenticate(OWNER);
    const response = await GET(request(`/api/apps/service-scopes?appDid=${APP_DID}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appDid: APP_DID, approvedServiceScopes: [] });
  });
});

describe('self-registered app on the existing signed proposal/decision/mint rail', () => {
  it('mints nothing before/pending approval, then exactly the countersigned subset and records audit evidence', async () => {
    await mintedScopes([]);
    const row = await proposal(['identity:read']);
    await mintedScopes([]);
    const response = await decision(row, 'approve');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.executionError).toBeUndefined();
    expect(result.data).toMatchObject({ appDid: APP_DID, approvedServiceScopes: ['identity:read'] });
    await mintedScopes(['identity:read']);
    const [audit] = await database.select().from(operatorApprovals);
    expect(audit.status).toBe('approved');
    expect(audit.decision?.payload).toMatchObject({ decision: 'approve', decidedBy: OPERATOR });
    const signed = audit.decision!;
    expect(authCrypto.verifySync(signed.signature, canonicalize(signed.payload), signed.senderPubkey)).toBe(true);
    const [app] = await database.select().from(registryApps);
    expect(app.serviceScopesApprovalId).toBe(row.proposalId);
    expect(app.serviceScopesApprovedAt).toBeInstanceOf(Date);
    authenticate();
    expect((await (await GET(request('/api/apps/service-scopes'))).json()).apps[0]).toMatchObject({
      requestedScopes: ['identity:read', 'identity:write'], approvedServiceScopes: ['identity:read'],
      approvalId: row.proposalId, approvedAt: app.serviceScopesApprovedAt!.toISOString(),
    });
    expect(state.provision).not.toHaveBeenCalled();
  });

  it('denial keeps requested scopes pending and minted scopes empty', async () => {
    await mintedScopes([]);
    const row = await proposal(['identity:read', 'identity:write']);
    const response = await decision(row, 'reject');
    expect(response.status).toBe(200);
    expect((await response.json()).executionError).toBeUndefined();
    await mintedScopes([]);
    const [app] = await database.select().from(registryApps);
    expect(app.approvedServiceScopes).toEqual([]);
    expect(app.serviceScopesApprovalId).toBeNull();
    const [audit] = await database.select().from(operatorApprovals);
    expect(audit.status).toBe('denied');
    expect(audit.decision?.payload).toMatchObject({ decision: 'reject', decidedBy: OPERATOR });
  });

  it('rejects a decision signed by the app key instead of the operator key and grants nothing', async () => {
    const row = await proposal(['identity:write']);
    expect((await decision(row, 'approve', appKey)).status).toBe(400);
    await mintedScopes([]);
    const [audit] = await database.select().from(operatorApprovals);
    expect(audit.status).toBe('pending');
    expect(audit.decision).toBeNull();
  });

  it('never executes an unsigned approval even when generic countersigning is optional', async () => {
    vi.stubEnv('OPERATOR_COUNTERSIGN_REQUIRED', 'false');
    try {
      const row = await proposal(['identity:write']);
      authenticate();
      const response = await decide(request(`/jin/api/operator-approvals/${row.proposalId}/decision`, {
        decision: 'approve',
      }), { params: Promise.resolve({ proposalId: row.proposalId }) });
      expect(response.status).toBe(200);
      expect((await response.json()).executionError).toContain('requires a countersigned operator decision');
      await mintedScopes([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a forged operator signature even when it names the registered operator key', async () => {
    const row = await proposal(['identity:write']);
    authenticate();
    const decidedAt = new Date().toISOString();
    const response = await decide(request(`/jin/api/operator-approvals/${row.proposalId}/decision`, {
      decision: 'approve', decidedAt,
      operatorSignature: {
        keyId: authCrypto.getPublicKey(operatorKey), alg: 'ed25519',
        sig: authCrypto.signSync(countersignedMessage({
          contentHash: row.contentHash!, decision: 'approve', decidedAt,
        }), appKey),
      },
    }), { params: Promise.resolve({ proposalId: row.proposalId }) });
    expect(response.status).toBe(400);
    await mintedScopes([]);
  });

  it('removes the approved scope on the next mint after a countersigned revoke', async () => {
    const grant = await proposal(['identity:read']);
    expect((await decision(grant, 'approve')).status).toBe(200);
    await mintedScopes(['identity:read']);
    const revoke = await proposal(['identity:read'], 'revoke');
    const response = await decision(revoke, 'approve');
    expect(response.status).toBe(200);
    expect((await response.json()).executionError).toBeUndefined();
    await mintedScopes([]);
    const [app] = await database.select().from(registryApps);
    expect(app.requestedScopes).toEqual(['identity:read', 'identity:write']);
    expect(app.serviceScopesApprovalId).toBe(revoke.proposalId);
  });
});
