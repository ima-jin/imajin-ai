import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { canonicalize, crypto as authCrypto, provideInternalApiKey, agentCardUrl } from '@imajin/auth';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { createOrgGrantHarness } from './org-grant-harness';

const fixture = vi.hoisted(() => ({
  db: null as unknown, nodeDid: vi.fn(), createProvision: vi.fn(), revokeProvision: vi.fn(), cronAuth: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/registry'),
  ...await import('@/src/db/schemas/media'),
  get db() { return fixture.db; },
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: fixture.nodeDid }));
vi.mock('@/src/cron/auth', () => ({ requireCronAuth: fixture.cronAuth }));
// Notification transport is stubbed; grant lifecycle, ingest, signatures and storage are real.
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../agent-provisioner', () => ({
  // Denial-only tests assert these operations are never reached by the real auth gate.
  createProvision: fixture.createProvision,
  revokeProvision: fixture.revokeProvision,
  listProvisions: vi.fn(),
  getProvision: vi.fn(),
  ProvisionError: class extends Error { status = 400; },
}));

import { GET as listGrants, POST as issue } from '@/app/auth/api/grants/route';
import { DELETE as revoke } from '@/app/auth/api/grants/[grantId]/route';
import { POST as renew } from '@/app/auth/api/grants/[grantId]/renew/route';
import { PUT as addCapability, DELETE as removeCapability } from '@/app/auth/api/grants/[grantId]/capabilities/[capability]/route';
import { POST as introspect } from '@/app/auth/api/internal/grants/introspect/route';
import { resolveAgentAuthority } from '../agent-authority';
import { authorizeEvidencePublisher } from '@/src/lib/turn-evidence/authorize-publisher';
import { POST as publishEvidence } from '@/app/auth/api/attestations/turn-evidence/route';
import { POST as provisionAgent } from '@/app/auth/api/agents/provision/route';
import { DELETE as revokeProvision } from '@/app/auth/api/agents/provision/[id]/route';
import { GET as retryAuditJob } from '@/app/api/cron/grant-audit-retry/route';
import { retryGrantRevocationAudits } from '../grants';
import { AGENT_KEYPAIR, signedItem, wireBody } from '@/src/lib/turn-evidence/__tests__/helpers';

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const HUMAN = 'did:imajin:org-grant-human';
const ORG = 'did:imajin:org-grant-business';
const OTHER_ORG = 'did:imajin:org-grant-other';
const AGENT = 'did:imajin:org-grant-agent';
const NODE = 'did:imajin:org-grant-node';
const keys = authCrypto.generateKeypair();
let harness: Awaited<ReturnType<typeof createOrgGrantHarness>>;
let internalKey: string;
let role: string;
let subtype: string;
let allowedServices: string[] | null;
let authStatus: number;

function request(method = 'POST', options: {
  as?: string | null;
  actingFor?: string;
  body?: unknown;
  authenticated?: boolean;
} = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.authenticated !== false) headers.set('authorization', 'Bearer org-grant-fixture');
  if (options.as !== null) headers.set('x-acting-as', options.as ?? ORG);
  if (options.actingFor) headers.set('x-acting-for', options.actingFor);
  return new NextRequest('https://node.test/auth/api/grants', {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }),
  });
}

const grantBody = () => ({
  agentDid: AGENT,
  capabilities: ['evidence:publish'],
  audience: { type: 'dids', values: [ORG] },
  ttlMs: 60_000,
});
const grantParams = (grantId: string) => ({ params: Promise.resolve({ grantId }) });
const capParams = (grantId: string, capability = 'messages:write') =>
  ({ params: Promise.resolve({ grantId, capability: encodeURIComponent(capability) }) });

async function issuedGrant() {
  const response = await issue(request('POST', { body: grantBody() }));
  expect(response.status).toBe(201);
  const { grant } = await response.json();
  return grant as { grantId: string; delegatorDid: string; expiry: string };
}

async function mutate(action: string, grantId: string, options: Parameters<typeof request>[1] = {}) {
  switch (action) {
    case 'issue': return issue(request('POST', { ...options, body: grantBody() }));
    case 'renew': return renew(request('POST', options), grantParams(grantId));
    case 'add': return addCapability(request('PUT', options), capParams(grantId));
    case 'remove': return removeCapability(request('DELETE', options), capParams(grantId, 'evidence:publish'));
    case 'revoke': return revoke(request('DELETE', options), grantParams(grantId));
    default: throw new Error(`Unknown test action: ${action}`);
  }
}

async function attestationsFor(grantId: string) {
  const rows = await harness.db.select().from((await import('@/src/db/schemas/auth')).attestations);
  return rows.filter((row) => (row.payload as { grantId?: string } | null)?.grantId === grantId);
}

async function assertSignedEvent(grantId: string, event: string, capability?: string) {
  const rows = (await attestationsFor(grantId)).filter((row) => row.type === `delegation.grant.${event}`);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toMatchObject({ issuerDid: NODE, subjectDid: ORG, attestationStatus: null });
  expect(row.payload).toEqual({
    grantId, delegatorDid: ORG, actorDid: HUMAN, event,
    ...(capability ? { capability } : {}),
    ...(['renewed', 'revoked', 'capability_revoked'].includes(event) ? { occurredAt: expect.any(String) } : {}),
  });
  const signedMessage = canonicalize({
    subject_did: row.subjectDid, type: row.type, context_id: row.contextId,
    context_type: row.contextType, payload: row.payload, issued_at: row.issuedAt.getTime(),
  });
  expect(authCrypto.verifySync(row.signature, signedMessage, keys.publicKey)).toBe(true);
  const tampered = canonicalize({
    subject_did: HUMAN, type: row.type, context_id: row.contextId,
    context_type: row.contextType, payload: row.payload, issued_at: row.issuedAt.getTime(),
  });
  expect(authCrypto.verifySync(row.signature, tampered, keys.publicKey)).toBe(false);
  const events = await harness.client.query<{ actor_did: string }>(
    'SELECT actor_did FROM auth.delegation_grant_events WHERE grant_id = $1 AND event = $2',
    [grantId, event],
  );
  expect(events.rows).toEqual([{ actor_did: HUMAN }]);
}

beforeAll(async () => {
  harness = await createOrgGrantHarness();
  fixture.db = harness.db;
});
afterAll(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await harness.client.exec(`INSERT INTO auth.identities (id, public_key, scope, subtype, name) VALUES
    ('${HUMAN}', 'human-key', 'actor', 'human', 'Controller'),
    ('${ORG}', 'org-key', 'business', NULL, 'Org'),
    ('${OTHER_ORG}', 'other-org-key', 'business', NULL, 'Other org');
    INSERT INTO auth.identity_members (identity_did, member_did, role) VALUES ('${ORG}', '${HUMAN}', 'owner');`);
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:fixture@localhost:5432/unused');
  fixture.createProvision.mockReset();
  fixture.revokeProvision.mockReset();
  fixture.cronAuth.mockResolvedValue(null);
  role = 'owner';
  subtype = 'human';
  allowedServices = null;
  authStatus = 200;
  internalKey = randomUUID();
  provideInternalApiKey(internalKey);
  fixture.nodeDid.mockResolvedValue(NODE);
  vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
  vi.stubEnv('AUTH_INTERNAL_API_KEY', internalKey);
  vi.stubEnv('AUTH_SERVICE_URL', 'https://auth.fixture.test');
  vi.stubEnv('AGENT_AUTHORITY_MODE', 'grants-first');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/api/validate') {
      return Response.json({ valid: true, identity: { id: HUMAN, scope: 'actor', subtype } }, { status: authStatus });
    }
    if (url.pathname === '/api/session') {
      return Response.json({ did: HUMAN, scope: 'actor', subtype }, { status: authStatus });
    }
    if (url.pathname.includes('/controllers/')) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${internalKey}`);
      return Response.json({ valid: true, role, allowedServices });
    }
    if (url.pathname === '/api/internal/verify-delegation') {
      const { agentDid, principalDid } = JSON.parse(String(init?.body));
      return Response.json(await resolveAgentAuthority(agentDid, principalDid));
    }
    throw new Error(`Unexpected upstream request: ${url.pathname}`);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('organization grant acceptance (#2997)', () => {
  it('passes TTL through the real route, clamps at 30 days and preserves that lease on no-choice renewal', async () => {
    const grant = await issuedGrant();
    const ttlMs = 30 * 86400000;
    const first = await renew(request('POST', { body: { ttlMs: ttlMs * 2 } }), grantParams(grant.grantId));
    expect(first.status).toBe(200);
    const { grant: renewed } = await first.json();
    const anchor = await harness.client.query<{ created_at: Date }>(
      "SELECT created_at FROM auth.delegation_grant_events WHERE grant_id = $1 AND event = 'renewed'", [grant.grantId],
    );
    expect(Date.parse(renewed.expiresAt) - anchor.rows[0].created_at.getTime()).toBe(ttlMs);
    const second = await renew(request('POST'), grantParams(grant.grantId));
    expect(second.status).toBe(200);
    const { grant: preserved } = await second.json();
    const row = await harness.client.query<{ expires_at: Date; updated_at: Date }>(
      'SELECT expires_at, updated_at FROM auth.delegation_grants WHERE id = $1', [grant.grantId],
    );
    expect(row.rows[0].expires_at.getTime() - row.rows[0].updated_at.getTime()).toBe(ttlMs);
    expect(preserved.expiresAt).toBe(row.rows[0].expires_at.toISOString());
  });
  it.each([
    ['revoke', 'signing'], ['remove', 'signing'],
    ['revoke', 'attestation'], ['remove', 'attestation'],
    ['revoke', 'history'], ['remove', 'history'],
  ])('commits %s before %s failure, keeps authority denied and retries signed history exactly once', async (action, failure) => {
    const grant = await issuedGrant();
    const table = failure === 'history' ? 'delegation_grant_events' : 'attestations';
    if (failure === 'signing') vi.stubEnv('AUTH_PRIVATE_KEY', '');
    else await harness.client.exec(`ALTER TABLE auth.${table} ADD CONSTRAINT reject_retry_fixture CHECK (false) NOT VALID`);
    try {
      expect((await mutate(action, grant.grantId)).status).toBe(200);
      expect(await authorizeEvidencePublisher(AGENT, ORG)).toEqual({ authorized: false });
      const queued = await harness.client.query<{ pending_revocation_audits: unknown[] }>(
        'SELECT pending_revocation_audits FROM auth.delegation_grants WHERE id = $1', [grant.grantId],
      );
      expect(queued.rows[0].pending_revocation_audits).toEqual([expect.objectContaining({
        grantId: grant.grantId, delegatorDid: ORG, actorDid: HUMAN,
        event: action === 'revoke' ? 'revoked' : 'capability_revoked',
        occurredAt: expect.any(String),
      })]);
      const committed = await harness.snapshot();
      expect(await retryGrantRevocationAudits()).toEqual({ attempted: 1, delivered: 0, failed: 1 });
      expect(await harness.snapshot()).toEqual(committed);
    } finally {
      if (failure === 'signing') vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
      else await harness.client.exec(`ALTER TABLE auth.${table} DROP CONSTRAINT reject_retry_fixture`);
    }
    // No in-memory queue is involved: the scheduled retry reads the committed intent.
    const response = await retryAuditJob(request('GET', { as: null }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, attempted: 1, delivered: 1, failed: 0 });
    await Promise.all([retryGrantRevocationAudits(), retryGrantRevocationAudits()]);
    await assertSignedEvent(grant.grantId, action === 'revoke' ? 'revoked' : 'capability_revoked',
      action === 'remove' ? 'evidence:publish' : undefined);
    expect(await authorizeEvidencePublisher(AGENT, ORG)).toEqual({ authorized: false });
    const queued = await harness.client.query<{ pending_revocation_audits: unknown[] }>(
      'SELECT pending_revocation_audits FROM auth.delegation_grants WHERE id = $1', [grant.grantId],
    );
    expect(queued.rows[0].pending_revocation_audits).toEqual([]);
  });

  it.each([401, 503])('protects scheduled audit replay with cron auth (%s)', async (status) => {
    await issuedGrant();
    fixture.cronAuth.mockResolvedValue(Response.json({ error: 'Cron denied' }, { status }));
    const before = await harness.snapshot();
    expect((await retryAuditJob(request('GET'))).status).toBe(status);
    expect(await harness.snapshot()).toEqual(before);
  });

  it('replays multiple pending revocations exactly once under concurrent retry workers', async () => {
    const grant = await issuedGrant();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await mutate('remove', grant.grantId)).status).toBe(200);
    expect((await mutate('revoke', grant.grantId)).status).toBe(200);
    const queued = await harness.client.query<{ pending_revocation_audits: unknown[] }>(
      'SELECT pending_revocation_audits FROM auth.delegation_grants WHERE id = $1', [grant.grantId],
    );
    expect(queued.rows[0].pending_revocation_audits).toHaveLength(2);
    vi.stubEnv('AUTH_PRIVATE_KEY', keys.privateKey);
    await Promise.all([retryGrantRevocationAudits(), retryGrantRevocationAudits()]);
    await assertSignedEvent(grant.grantId, 'capability_revoked', 'evidence:publish');
    await assertSignedEvent(grant.grantId, 'revoked');
    expect(await retryGrantRevocationAudits()).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(await authorizeEvidencePublisher(AGENT, ORG)).toEqual({ authorized: false });
  });

  it('returns a retryable cron error when the pending scan is unavailable', async () => {
    const select = vi.spyOn(harness.db, 'select').mockImplementationOnce(() => { throw new Error('fixture unavailable'); });
    try {
      expect((await retryAuditJob(request('GET'))).status).toBe(500);
    } finally {
      select.mockRestore();
    }
  });
  it.each(['issue', 'renew', 'add'])('rolls back %s when signed audit storage fails', async (action) => {
    const grant = await issuedGrant();
    const before = await harness.snapshot();
    await harness.client.exec("ALTER TABLE auth.attestations ADD CONSTRAINT reject_grant_audit CHECK (type NOT LIKE 'delegation.grant.%') NOT VALID");
    try {
      await expect(mutate(action, grant.grantId)).rejects.toThrow();
      expect(await harness.snapshot()).toEqual(before);
    } finally {
      await harness.client.exec('ALTER TABLE auth.attestations DROP CONSTRAINT reject_grant_audit');
    }
  });

  it.each(['issue', 'renew', 'add'])('rolls back %s when queryable history storage fails', async (action) => {
    const grant = await issuedGrant();
    const before = await harness.snapshot();
    await harness.client.exec("ALTER TABLE auth.delegation_grant_events ADD CONSTRAINT reject_grant_history CHECK (event = 'unreachable_fixture') NOT VALID");
    try {
      await expect(mutate(action, grant.grantId)).rejects.toThrow();
      expect(await harness.snapshot()).toEqual(before);
    } finally {
      await harness.client.exec('ALTER TABLE auth.delegation_grant_events DROP CONSTRAINT reject_grant_history');
    }
  });

  it.each(['issue', 'renew', 'add'])('rolls back %s when signing is unconfigured', async (action) => {
    const grant = await issuedGrant();
    const before = await harness.snapshot();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(mutate(action, grant.grantId)).rejects.toThrow('AUTH_PRIVATE_KEY not set');
    expect(await harness.snapshot()).toEqual(before);
  });

  it.each(['service-restricted', 'agent'])('cannot bypass grant management through provisioning as %s', async (caller) => {
    await issuedGrant();
    if (caller === 'agent') subtype = 'agent';
    else allowedServices = ['events'];
    const before = await harness.snapshot();
    expect((await provisionAgent(request('POST', {
      body: { servingDid: ORG, name: 'Org agent', harness: 'nanoclaw', placement: 'hosted', scopes: ['messages:write'] },
    }))).status).toBe(403);
    expect((await revokeProvision(request('DELETE'), { params: Promise.resolve({ id: 'prov_fixture' }) })).status).toBe(403);
    expect(fixture.createProvision).not.toHaveBeenCalled();
    expect(fixture.revokeProvision).not.toHaveBeenCalled();
    expect(await harness.snapshot()).toEqual(before);
  });
  it.each(['owner', 'admin'])('%s issues as the business, never as their personal DID or through agent membership', async (controllerRole) => {
    role = controllerRole;
    const grant = await issuedGrant();
    expect(grant.delegatorDid).toBe(ORG);
    const orgResponse = await listGrants(request('GET'));
    expect(orgResponse.status).toBe(200);
    expect(await orgResponse.json()).toMatchObject({ grants: [{ grantId: grant.grantId, delegatorDid: ORG, agentDid: AGENT }] });
    const personal = await listGrants(request('GET', { as: null }));
    expect(await personal.json()).toEqual({ grants: [] });
    expect((await harness.client.query('SELECT * FROM auth.identity_members WHERE member_did = $1 OR identity_did = $1', [AGENT])).rows).toEqual([]);
    await assertSignedEvent(grant.grantId, 'issued');
  });

  it('renews, adds, removes and revokes as the org, retaining cryptographic proof of the human actor', async () => {
    const grant = await issuedGrant();
    const renewed = await mutate('renew', grant.grantId);
    expect(renewed.status).toBe(200);
    expect(new Date((await renewed.json()).grant.expiresAt).getTime()).toBeGreaterThan(new Date(grant.expiry).getTime());
    expect((await mutate('add', grant.grantId)).status).toBe(200);
    expect((await mutate('remove', grant.grantId)).status).toBe(200);
    expect((await mutate('revoke', grant.grantId)).status).toBe(200);
    await assertSignedEvent(grant.grantId, 'issued');
    await assertSignedEvent(grant.grantId, 'renewed');
    await assertSignedEvent(grant.grantId, 'capability_added', 'messages:write');
    await assertSignedEvent(grant.grantId, 'capability_revoked', 'evidence:publish');
    await assertSignedEvent(grant.grantId, 'revoked');
    expect(await attestationsFor(grant.grantId)).toHaveLength(5);
  });

  it('uses the browser act-as cookie and auth service allowance without mixing personal and org lists', async () => {
    const personalResponse = await issue(request('POST', { as: null, body: grantBody() }));
    expect(personalResponse.status).toBe(201);
    const personalGrant = (await personalResponse.json()).grant;
    role = 'admin';
    allowedServices = ['auth'];
    const cookie = `${SESSION_COOKIE_NAME}=fixture-session; x-acting-as=${encodeURIComponent(ORG)}`;
    const sessionRequest = (method: string) => new NextRequest('https://node.test/auth/api/grants', {
      method, headers: { cookie },
      ...(method === 'POST' ? { body: JSON.stringify(grantBody()) } : {}),
    });
    const response = await issue(sessionRequest('POST'));
    expect(response.status).toBe(201);
    const orgGrant = (await response.json()).grant;
    expect(orgGrant.delegatorDid).toBe(ORG);
    expect(await (await listGrants(sessionRequest('GET'))).json()).toMatchObject({
      grants: [{ grantId: orgGrant.grantId, delegatorDid: ORG }],
    });
    expect(await (await listGrants(request('GET', { as: null }))).json()).toMatchObject({
      grants: [{ grantId: personalGrant.grantId, delegatorDid: HUMAN }],
    });
    await assertSignedEvent(orgGrant.grantId, 'issued');
  });

  it('enforces capability and audience at actual execution/introspection, then denies immediately after revoke', async () => {
    const grant = await issuedGrant();
    const execute = async (capability: string, onBehalfOf = ORG) => {
      const response = await introspect(new NextRequest('https://node.test/auth/api/internal/grants/introspect', {
        method: 'POST', headers: { 'x-internal-key': internalKey },
        body: JSON.stringify({ agentDid: AGENT, capability, targetDid: onBehalfOf }),
      }));
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await execute('evidence:publish')).toMatchObject({ authorized: true, grantId: grant.grantId, delegatorDid: ORG });
    expect(await authorizeEvidencePublisher(AGENT, ORG)).toEqual({ authorized: true, grantId: grant.grantId });
    expect(await execute('messages:write')).toMatchObject({ authorized: false });
    expect(await execute('evidence:publish', OTHER_ORG)).toMatchObject({ authorized: false });
    expect(await authorizeEvidencePublisher(AGENT, OTHER_ORG)).toEqual({ authorized: false });
    expect(await resolveAgentAuthority(AGENT, ORG)).toMatchObject({ allowed: true, via: 'grant' });
    expect((await mutate('revoke', grant.grantId)).status).toBe(200);
    expect(await execute('evidence:publish')).toMatchObject({ authorized: false });
    expect(await execute('messages:write')).toMatchObject({ authorized: false });
    expect(await authorizeEvidencePublisher(AGENT, ORG)).toEqual({ authorized: false });
    expect(await resolveAgentAuthority(AGENT, ORG)).toEqual({ allowed: false, via: 'none' });
  });

  it('accepts a signed agent call for the org and returns 403 outside its scope and after revoke', async () => {
    const grant = await issuedGrant();
    await harness.client.query(
      'INSERT INTO auth.identities (id, public_key, scope, subtype) VALUES ($1, $2, $3, $4)',
      [AGENT, AGENT_KEYPAIR.publicKey, 'actor', 'agent'],
    );
    // This execution API calls onBehalfOf "principalDid"; the agent signs that
    // org claim, and production ingest narrows introspection to its delegator.
    const execute = (onBehalfOf: string) => publishEvidence(new NextRequest('https://node.test/auth/api/attestations/turn-evidence', {
      method: 'POST',
      body: JSON.stringify(wireBody([signedItem(0, {
        agentDid: AGENT, principalDid: onBehalfOf, turnEventId: `turn_${randomUUID()}`,
      })])),
    }));
    expect((await execute(ORG)).status).toBe(201);
    const evidence = await harness.client.query<{ delegator_did: string; delegation_grant_id: string }>(
      "SELECT delegator_did, delegation_grant_id FROM auth.attestations WHERE type = 'agent.turn.evidence'",
    );
    expect(evidence.rows).toEqual([{ delegator_did: ORG, delegation_grant_id: grant.grantId }]);
    const beforeDenied = await harness.snapshot();
    expect((await execute(OTHER_ORG)).status).toBe(403);
    expect(await harness.snapshot()).toEqual(beforeDenied);
    expect((await mutate('remove', grant.grantId)).status).toBe(200);
    const outsideCapability = await harness.snapshot();
    expect((await execute(ORG)).status).toBe(403);
    expect(await harness.snapshot()).toEqual(outsideCapability);
    expect((await addCapability(request('PUT'), capParams(grant.grantId, 'evidence:publish'))).status).toBe(200);
    expect((await execute(ORG)).status).toBe(201);
    expect((await mutate('revoke', grant.grantId)).status).toBe(200);
    const revoked = await harness.snapshot();
    expect((await execute(ORG)).status).toBe(403);
    expect(await harness.snapshot()).toEqual(revoked);
  });

  it.each(['issue', 'renew', 'add', 'remove', 'revoke'])('refuses service-restricted %s with 403 and zero writes', async (action) => {
    const grant = await issuedGrant();
    role = 'admin';
    allowedServices = ['events'];
    const before = await harness.snapshot();
    expect((await mutate(action, grant.grantId)).status).toBe(403);
    expect(await harness.snapshot()).toEqual(before);
  });

  it.each([
    { role: 'maintainer', subtype: 'human' },
    { role: 'member', subtype: 'human' },
    { role: 'agent', subtype: 'human' },
    { role: 'owner', subtype: 'agent' },
    { role: 'admin', subtype: 'agent' },
  ])('refuses org management for $role / $subtype across every mutation', async (caller) => {
    const grant = await issuedGrant();
    role = caller.role;
    subtype = caller.subtype;
    const before = await harness.snapshot();
    for (const action of ['issue', 'renew', 'add', 'remove', 'revoke']) {
      expect((await mutate(action, grant.grantId)).status, action).toBe(403);
    }
    expect(await harness.snapshot()).toEqual(before);
  });

  it('refuses an authenticated actingFor principal even when its upstream delegation is valid', async () => {
    const grant = await issuedGrant();
    // Give the authenticated fixture human a real grant so requireAuth's
    // actingFor bootstrap succeeds: the grant-management gate must still refuse.
    const { issueGrant } = await import('../grants');
    const authority = await issueGrant({
      delegatorDid: OTHER_ORG, agentDid: HUMAN, capabilities: ['messages:write'], audience: { type: 'all' },
    });
    expect(authority).toHaveProperty('grant');
    const before = await harness.snapshot();
    const issueResponse = await mutate('issue', grant.grantId, { as: ORG, actingFor: OTHER_ORG });
    expect(issueResponse.status).toBe(403);
    expect(await issueResponse.json()).toMatchObject({ onboarding: agentCardUrl() });
    for (const action of ['issue', 'renew', 'add', 'remove', 'revoke']) {
      expect((await mutate(action, grant.grantId, { as: ORG, actingFor: OTHER_ORG })).status, action).toBe(403);
    }
    expect(await harness.snapshot()).toEqual(before);
  });

  it('isolates other-org and personal authorization from org grant mutations', async () => {
    const grant = await issuedGrant();
    const before = await harness.snapshot();
    for (const as of [OTHER_ORG, null]) {
      for (const action of ['renew', 'add', 'remove', 'revoke']) {
        expect((await mutate(action, grant.grantId, { as })).status, `${as}:${action}`).toBe(403);
      }
    }
    expect(await harness.snapshot()).toEqual(before);
  });

  it('does not resurrect a revoked grant or attest idempotent no-ops', async () => {
    const grant = await issuedGrant();
    expect((await mutate('add', grant.grantId)).status).toBe(200);
    const afterAdd = await harness.snapshot();
    expect(await (await mutate('add', grant.grantId)).json()).toEqual({ added: false });
    expect(await harness.snapshot()).toEqual(afterAdd);
    expect((await mutate('remove', grant.grantId)).status).toBe(200);
    const afterRemove = await harness.snapshot();
    expect(await (await mutate('remove', grant.grantId)).json()).toEqual({ revoked: false });
    expect(await harness.snapshot()).toEqual(afterRemove);
    expect((await mutate('revoke', grant.grantId)).status).toBe(200);
    const revoked = await harness.snapshot();
    expect((await mutate('renew', grant.grantId)).status).toBe(409);
    expect((await mutate('add', grant.grantId)).status).toBe(409);
    expect(await (await mutate('revoke', grant.grantId)).json()).toEqual({ revoked: false });
    expect(await harness.snapshot()).toEqual(revoked);
  });

  it('propagates authentication errors before any lifecycle write or read', async () => {
    const grant = await issuedGrant();
    const before = await harness.snapshot();
    for (const action of ['issue', 'renew', 'add', 'remove', 'revoke']) {
      expect((await mutate(action, grant.grantId, { authenticated: false })).status, action).toBe(401);
    }
    expect((await listGrants(request('GET', { authenticated: false }))).status).toBe(401);
    authStatus = 401;
    expect((await issue(request('POST', { body: grantBody() }))).status).toBe(401);
    vi.mocked(fetch).mockRejectedValue(new Error('fixture upstream unavailable'));
    expect((await issue(request('POST', { body: grantBody() }))).status).toBe(503);
    expect(await harness.snapshot()).toEqual(before);
  });
});
