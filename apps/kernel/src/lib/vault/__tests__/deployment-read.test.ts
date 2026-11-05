import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeliveryRequest, HEADER, openDeliveryResponse, PURPOSE, REPOSITORY, signingPublicKey,
} from '../../../../../../deploy/infer-passthrough/deployment-read-protocol.mjs';

const h = vi.hoisted(() => ({
  proposal: {} as Record<string, unknown>, grant: {} as Record<string, unknown>,
  fetch: vi.fn(), ack: vi.fn(), get: vi.fn(), list: vi.fn(), emit: vi.fn(), node: {} as Record<string, string>,
}));
vi.mock('@/src/db', () => {
  const query = { from: vi.fn(), where: vi.fn(), limit: vi.fn(async () => [h.proposal]) };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return {
    operatorApprovals: { proposalId: 'proposalId', source: 'source', kind: 'kind', status: 'status' },
    db: { select: () => query },
  };
});
vi.mock('../index', () => ({
  fetchGrantSecret: h.fetch, ackGrant: h.ack, getGrantById: h.get, listGrantsForGrantee: h.list,
}));
vi.mock('../sealing', () => ({ getNodeSigningIdentity: () => h.node }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(), emitAttestation: h.emit,
}));

import { computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { deploymentReadRoute } from '../deployment-read';
import { requireDeploymentReadBinding, validDeploymentReadMetadata } from '../deployment-read-binding';

const host = generateKeyPairSync('ed25519').privateKey;
const kernel = generateKeyPairSync('ed25519').privateKey;
const recipientDid = `did:imajin:${signingPublicKey(host).slice(0, 16)}`;
const ownerDid = 'did:imajin:owner';
const binding = { repository: REPOSITORY, ownerDid, recipientDid };
const fixture = 'test-credential-not-a-token';
const grantId = 'vdg_fixture';
const base = `/api/vault/delegation/grants/${grantId}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('INFER_DEPLOY_READ_OWNER_DID', ownerDid);
  vi.stubEnv('INFER_DEPLOY_READ_RECIPIENT_DID', recipientDid);
  vi.stubEnv('INFER_DEPLOY_READ_RECIPIENT_PUBLIC_KEY', signingPublicKey(host));
  h.node = {
    senderDid: `did:imajin:${signingPublicKey(kernel).slice(0, 16)}`,
    senderPubkey: signingPublicKey(kernel),
    privateKeyHex: kernel.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex'),
  };
  const expiresAt = new Date(Date.now() + 120_000);
  h.grant = {
    id: grantId, subject: ownerDid, grantedTo: recipientDid, purpose: PURPOSE,
    field: 'vault-imported-key:deployimport_fixture', oneTime: false, status: 'active', expiresAt,
    createdAt: new Date(), lastFetchedAt: new Date(),
  };
  h.proposal = {
    proposalId: 'deployimport_fixture', source: 'vault', kind: 'vault:import', status: 'applied',
    summary: 'Import', keysTouched: [], appliedAt: new Date(),
    detail: {
      ownerDid, consumerDid: recipientDid, purpose: PURPOSE, expiresAt: expiresAt.toISOString(),
      deploymentRead: { repository: REPOSITORY, recipientDid },
    },
  };
  h.proposal.contentHash = computeApprovalContentHash({
    proposalId: h.proposal.proposalId, source: h.proposal.source, kind: h.proposal.kind,
    summary: h.proposal.summary, keysTouched: h.proposal.keysTouched, detail: h.proposal.detail,
  } as never);
  h.get.mockImplementation(async () => h.grant);
  h.fetch.mockImplementation(async () => ({ status: 'ok', value: fixture, grant: h.grant }));
  h.ack.mockResolvedValue({ status: 'ok', ackedAt: new Date() });
  h.list.mockResolvedValue([{ grantId }]);
  h.emit.mockResolvedValue({ attestationId: 'attestation_fixture' });
});
afterEach(() => vi.unstubAllEnvs());

async function call(action: 'list' | 'fetch' | 'ack', options: {
  key?: typeof host; binding?: typeof binding; body?: string; header?: string;
} = {}) {
  const path = action === 'list' ? `/api/vault/delegation/grants?purpose=${encodeURIComponent(PURPOSE)}` : `${base}/${action}`;
  const method = action === 'list' ? 'GET' : 'POST';
  const body = options.body ?? (action === 'ack' ? JSON.stringify({ outcome: 'used', fetchedAt: (h.grant.lastFetchedAt as Date).toISOString() }) : '');
  const signed = createDeliveryRequest(method, path, body, options.binding ?? binding, options.key ?? host);
  const request = new Request(`https://kernel.test${path}`, {
    method, headers: { [HEADER]: options.header ?? signed.header }, body: body || undefined,
  });
  const response = await deploymentReadRoute(request, action, action === 'list' ? undefined : grantId);
  const wire = await response.json();
  const opened = response.ok ? openDeliveryResponse(wire, signed, signingPublicKey(kernel)) : wire;
  return { response, opened, wire };
}

describe('gateway deployment-read route authority', () => {
  it('discovers and fetches only the bound import, returns encrypted signed provenance and acknowledges', async () => {
    expect((await call('list')).opened).toMatchObject({ grants: [{ grantId }] });
    const result = await call('fetch');
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.opened).toMatchObject({ value: fixture, repository: REPOSITORY, purpose: PURPOSE, recipientDid });
    expect(h.fetch).toHaveBeenCalledWith({ grantId, granteeDid: recipientDid, deploymentReadDelivery: true });
    expect((await call('ack')).opened).toMatchObject({ ok: true });
    expect(h.ack).toHaveBeenCalledWith({
      grantId, granteeDid: recipientDid, outcome: 'used', deploymentReadDelivery: true,
      deploymentFetchedAt: (h.grant.lastFetchedAt as Date).toISOString(),
    });
    expect(JSON.stringify([result.wire, h.emit.mock.calls])).not.toContain(fixture);
    expect(h.emit.mock.calls.map(([event]) => event.type)).toEqual(['vault.deployment-read.fetched', 'vault.deployment-read.acked']);
  });

  it('denies wrong principal before decrypting', async () => {
    h.grant.subject = 'did:imajin:wrong';
    expect((await call('fetch')).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('denies wrong repository before decrypting', async () => {
    expect((await call('fetch', { binding: { ...binding, repository: 'ima-jin/other' } })).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('denies wrong recipient before decrypting', async () => {
    const stranger = generateKeyPairSync('ed25519').privateKey;
    expect((await call('fetch', { key: stranger })).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('denies wrong purpose before decrypting', async () => {
    h.grant.purpose = 'other-purpose';
    expect((await call('fetch')).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('denies expired authority before decrypting', async () => {
    h.grant.expiresAt = new Date(0);
    expect((await call('fetch')).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('denies revoked authority before decrypting', async () => {
    h.grant.status = 'revoked';
    expect((await call('fetch')).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { oneTime: true }, { expiresAt: null }, { field: 'not-an-import' },
  ])('refuses incompatible grant metadata %j', async extra => {
    Object.assign(h.grant, extra);
    expect((await call('fetch')).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('refuses changed approval metadata and mismatched grant expiry', async () => {
    const detail = h.proposal.detail as Record<string, unknown>;
    detail.purpose = 'changed';
    expect((await call('fetch')).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('refuses missing policy and invalid headers', async () => {
    expect((await call('fetch', { header: 'invalid' })).response.status).toBe(403);
    vi.stubEnv('INFER_DEPLOY_READ_OWNER_DID', '');
    expect((await call('fetch')).response.status).toBe(403);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rechecks revocation after decrypt and requires a persisted attestation', async () => {
    h.fetch.mockImplementationOnce(async () => {
      h.grant.status = 'revoked';
      return { status: 'ok', value: fixture };
    });
    expect((await call('fetch')).response.status).toBe(403);
    h.grant.status = 'active';
    h.emit.mockResolvedValueOnce({});
    const result = await call('fetch');
    expect(result.response.status).toBe(403);
    expect(JSON.stringify(result.wire)).not.toContain(fixture);
  });

  it.each(['{"outcome":"failed"}', '{"outcome":"used","note":"not allowed"}'])('rejects non-fixed ack body %s', async body => {
    expect((await call('ack', { body })).response.status).toBe(403);
    expect(h.ack).not.toHaveBeenCalled();
  });

  it('requires an empty fetch body and a successful fetch/ack result', async () => {
    expect((await call('fetch', { body: '{}' })).response.status).toBe(403);
    h.fetch.mockResolvedValueOnce({ status: 'inactive' });
    expect((await call('fetch')).response.status).toBe(403);
    h.ack.mockResolvedValueOnce({ status: 'not_fetched' });
    expect((await call('ack')).response.status).toBe(403);
  });

  it('retries delivery without consuming the import grant', async () => {
    expect((await call('fetch')).response.status).toBe(200);
    expect((await call('fetch')).response.status).toBe(200);
    expect((await call('ack')).response.status).toBe(200);
    expect((await call('ack')).response.status).toBe(200);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('reserved import binding validation', () => {
  it('reserves its purpose and requires all policy bindings with a finite expiry', () => {
    const detail = h.proposal.detail as Record<string, unknown>;
    expect(validDeploymentReadMetadata(detail)).toBe(true);
    expect(() => requireDeploymentReadBinding(detail)).not.toThrow();
    for (const extra of [
      { deploymentRead: undefined }, { deploymentRead: null }, { expiresAt: null },
      { purpose: 'other-purpose' }, { consumerDid: 'did:imajin:wrong' },
      { deploymentRead: { repository: REPOSITORY, recipientDid, unexpected: true } },
    ]) expect(validDeploymentReadMetadata({ ...detail, ...extra })).toBe(false);
    for (const extra of [{ ownerDid: 'did:imajin:wrong' }, { expiresAt: new Date(0).toISOString() }]) {
      expect(() => requireDeploymentReadBinding({ ...detail, ...extra })).toThrow();
    }
  });
});
