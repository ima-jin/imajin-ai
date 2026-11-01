import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { canonicalize, FUTURE_TOLERANCE, SIGNED_MESSAGE_MAX_AGE } from '@imajin/auth';
import { createOrgGrantHarness } from './org-grant-harness';

const fixture = vi.hoisted(() => ({ db: null as unknown, nodeInfo: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  get db() { return fixture.db; },
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: fixture.nodeInfo }));

import { POST } from '@/app/auth/api/grants/received/operator-approvals/route';
import { GET as spec } from '@/app/auth/api/spec/route';
import { APPROVALS_LEASE_OPERATION, effectiveOperatorApprovalsLease } from '../operator-approvals-lease';

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

const AGENT = 'did:imajin:lease-agent';
const OTHER = 'did:imajin:lease-other';
const HUMAN = 'did:imajin:lease-human';
const ORG = 'did:imajin:lease-org';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const now = Date.parse('2026-11-01T20:00:00Z');
const later = new Date(now + 48 * 60 * 60 * 1000);
let harness: Awaited<ReturnType<typeof createOrgGrantHarness>>;

function signed(overrides: Record<string, unknown> = {}) {
  const fields = {
    from: AGENT, type: 'agent', timestamp: Date.now(),
    payload: { operation: APPROVALS_LEASE_OPERATION }, ...overrides,
  };
  return { ...fields, signature: sign(null, Buffer.from(canonicalize(fields)), keys.privateKey).toString('hex') };
}

function read(raw: unknown = signed(), headers?: HeadersInit, query = '') {
  return POST(new Request(`https://node.test/auth/api/grants/received/operator-approvals${query}`, {
    method: 'POST', headers, body: JSON.stringify(raw),
  }));
}

async function grant(id = 'grant_1', options: {
  agentDid?: string; delegatorDid?: string; expiresAt?: Date; status?: string;
  audience?: unknown; capability?: string; capabilityStatus?: string;
} = {}) {
  await harness.client.query(
    `INSERT INTO auth.delegation_grants (id, agent_did, delegator_did, audience, expires_at, status)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, options.agentDid ?? AGENT, options.delegatorDid ?? HUMAN,
      JSON.stringify(options.audience ?? { type: 'all' }), options.expiresAt ?? later, options.status ?? 'active'],
  );
  await harness.client.query(
    `INSERT INTO auth.delegation_grant_capabilities (id, grant_id, capability, status) VALUES ($1, $2, $3, $4)`,
    [`cap_${id}`, id, options.capability ?? 'operator:approvals', options.capabilityStatus ?? 'active'],
  );
}

beforeAll(async () => {
  harness = await createOrgGrantHarness();
  fixture.db = harness.db;
});
afterAll(async () => { await harness.close(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  fixture.nodeInfo.mockReset().mockResolvedValue({ nodeOperatorDid: HUMAN });
  await harness.reset();
  await harness.client.query(
    `INSERT INTO auth.identities (id, public_key, scope, subtype) VALUES ($1, $2, 'actor', 'agent')`,
    [AGENT, publicKey],
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('signed self-scoped lease read', () => {
  it.each([HUMAN, ORG])('reads only its received lease from personal/org delegator %s without any credential headers', async (delegatorDid) => {
    fixture.nodeInfo.mockResolvedValue({ nodeOperatorDid: delegatorDid });
    await grant('grant_1', { delegatorDid, audience: { type: 'dids', values: [delegatorDid] } });
    const before = await harness.snapshot();
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      lease: { grantId: 'grant_1', capability: 'operator:approvals', expiresAt: later.toISOString() },
    });
    expect(await harness.snapshot()).toEqual(before);
  });

  it.each([
    { 'x-acting-as': ORG },
    { cookie: `x-acting-as=${ORG}; imajin_session=unused` },
    { 'x-acting-for': HUMAN },
  ])('does not redirect the signer through acting identity overlays %j', async (headers) => {
    await grant();
    await grant('foreign', { agentDid: ORG, expiresAt: new Date(later.getTime() + 1000) });
    const response = await read(signed(), headers, `?agentDid=${ORG}&delegatorDid=${HUMAN}&grantId=foreign`);
    expect((await response.json()).lease.grantId).toBe('grant_1');
  });

  it('never returns another agent’s or the delegator’s received grants', async () => {
    await grant('other', { agentDid: OTHER });
    await grant('delegator', { agentDid: HUMAN });
    expect(await (await read()).json()).toEqual({ lease: null });
  });

  it('binds the signature to the grantee and operation, even if the claimed agent shares a registered key', async () => {
    await harness.client.query(
      `INSERT INTO auth.identities (id, public_key, scope, subtype) VALUES ($1, $2, 'actor', 'agent')`,
      [OTHER, publicKey.toUpperCase()],
    );
    expect((await read({ ...signed(), from: OTHER })).status).toBe(401);
    expect((await read({ ...signed(), timestamp: now - 1 })).status).toBe(401);
    expect((await read(signed({ payload: { operation: 'reach_status' } }))).status).toBe(401);
    expect((await read({ ...signed(), payload: { operation: 'something-else' } })).status).toBe(401);
  });

  it.each([
    null, [], {}, { type: 'agent' }, { from: AGENT, type: 'human' },
    signed({ timestamp: Number.NaN }), signed({ timestamp: 1.5 }), signed({ timestamp: 'now' }),
    signed({ timestamp: Number.MAX_SAFE_INTEGER + 1 }), signed({ payload: null }),
    signed({ payload: [] }), signed({ payload: 'bad' }),
    { ...signed(), signature: 'bad' }, { ...signed(), signature: undefined },
    signed({ from: 'did:imajin:unknown' }),
  ])('denies malformed or unauthenticated input %#', async (input) => {
    const response = await read(input);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fixture.nodeInfo).not.toHaveBeenCalled();
  });

  it.each([
    { 'x-internal-key': 'unused' }, { authorization: 'Bearer unused' }, { cookie: 'imajin_session=unused' },
  ])('does not accept alternative credentials instead of the signature %j', async (headers) => {
    expect((await read({}, headers)).status).toBe(401);
  });

  it.each([-SIGNED_MESSAGE_MAX_AGE - 1, FUTURE_TOLERANCE + 1])('rejects stale/future signatures (%s)', async (offset) => {
    expect((await read(signed({ timestamp: now + offset }))).status).toBe(401);
  });

  it.each(['suspended', 'human', 'rotated'])('denies a %s identity/current-key mismatch', async (kind) => {
    if (kind === 'suspended') await harness.client.query('UPDATE auth.identities SET suspended_at = $1', [new Date()]);
    if (kind === 'human') await harness.client.exec("UPDATE auth.identities SET subtype = 'human'");
    if (kind === 'rotated') {
      const rotated = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
      await harness.client.query('UPDATE auth.identities SET public_key = $1', [rotated]);
    }
    expect((await read()).status).toBe(401);
  });

  it('rejects invalid JSON and fails closed without disclosing lookup errors', async () => {
    expect((await POST(new Request('https://node.test', { method: 'POST', body: '{' }))).status).toBe(400);
    fixture.nodeInfo.mockRejectedValueOnce(new Error('private storage details'));
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Lease lookup failed' });
    vi.spyOn(harness.db, 'select').mockImplementationOnce(() => { throw new Error('private identity error'); });
    expect((await read()).status).toBe(503);
  });
});

describe('effective lease semantics using real SQL', () => {
  it.each([
    { status: 'revoked' },
    { expiresAt: new Date(now - 1) },
    { expiresAt: new Date(now) },
    { capabilityStatus: 'revoked' },
    { capability: 'messages:read' },
    { audience: { type: 'dids', values: [OTHER] } },
    { audience: { type: 'invalid' } },
  ])('omits ineligible received grants %j without deleting history', async (options) => {
    await grant('ineligible', options);
    const before = await harness.snapshot();
    expect(await effectiveOperatorApprovalsLease(AGENT)).toBeNull();
    expect(await harness.snapshot()).toEqual(before);
  });

  it('returns null for no grant or no configured operator', async () => {
    expect(await effectiveOperatorApprovalsLease(AGENT)).toBeNull();
    await grant();
    fixture.nodeInfo.mockResolvedValueOnce(null);
    expect(await effectiveOperatorApprovalsLease(AGENT)).toBeNull();
    fixture.nodeInfo.mockResolvedValueOnce({ nodeOperatorDid: null });
    expect(await effectiveOperatorApprovalsLease(AGENT)).toBeNull();
  });

  it('uses the latest eligible expiry, tie-breaks by ID, and re-reads revocation/renewal', async () => {
    await grant('short', { expiresAt: new Date(now + 1000) });
    await grant('z-long');
    await grant('a-long', { delegatorDid: ORG });
    await grant('irrelevant-longest', { expiresAt: new Date(later.getTime() + 1000), capabilityStatus: 'revoked' });
    expect((await effectiveOperatorApprovalsLease(AGENT))?.grantId).toBe('a-long');
    await harness.client.exec("UPDATE auth.delegation_grants SET status = 'revoked' WHERE id = 'a-long'");
    expect((await effectiveOperatorApprovalsLease(AGENT))?.grantId).toBe('z-long');
    await harness.client.exec("UPDATE auth.delegation_grant_capabilities SET status = 'revoked' WHERE grant_id = 'z-long'");
    expect((await effectiveOperatorApprovalsLease(AGENT))?.grantId).toBe('short');
    await harness.client.query("UPDATE auth.delegation_grants SET expires_at = $1 WHERE id = 'short'", [later]);
    expect((await effectiveOperatorApprovalsLease(AGENT))?.expiresAt).toBe(later.toISOString());
  });

  it.each([24, 1])('returns the exact persisted T-%sh expiry without inferring a TTL', async (hours) => {
    const expiresAt = new Date(now + hours * 60 * 60 * 1000);
    await grant('warning', { expiresAt });
    expect(await effectiveOperatorApprovalsLease(AGENT)).toEqual({
      grantId: 'warning', capability: 'operator:approvals', expiresAt: expiresAt.toISOString(),
    });
  });
});

it('serves a discoverable signed self-only contract, multiple-grant semantics and consumer warning guidance', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(fileURLToPath(new URL('../../../../', import.meta.url)));
  const response = await spec();
  const document = parse(await response.text());
  const operation = document.paths['/api/grants/received/operator-approvals'].post;
  expect(operation.operationId).toBe('readOwnOperatorApprovalsLease');
  expect(operation.security).toEqual([]);
  expect(operation.requestBody.content['application/json'].schema.required).toEqual(['from', 'type', 'timestamp', 'payload', 'signature']);
  expect(operation.description).toContain('latest expiresAt');
  expect(operation.description).toContain('lexicographically ascending grantId');
  expect(operation.description).toContain('T-24h and T-1h');
  expect(operation.description).toContain('/auth/agents → the grant → Renew');
  expect(operation.description).toContain('Do not guess a TTL');
  const lease = operation.responses['200'].content['application/json'].schema.properties.lease.oneOf.at(1);
  expect(lease.additionalProperties).toBe(false);
  expect(Object.keys(lease.properties)).toEqual(['grantId', 'capability', 'expiresAt']);
});
