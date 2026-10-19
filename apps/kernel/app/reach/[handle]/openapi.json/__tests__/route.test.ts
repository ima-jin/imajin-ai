import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse } from 'yaml';
import { NextRequest } from 'next/server';
import { GET, OPTIONS } from '../route';
import { reachOpenApi } from '@/src/lib/kernel/reach-openapi';
import { GET as card } from '@/app/.well-known/agent/[id]/route';
import { POST as askSend } from '@/app/auth/api/agents/[did]/reach/route';
import { POST as status } from '@/app/auth/api/agents/[did]/reach/[reachId]/status/route';

const mocks = vi.hoisted(() => ({
  recipient: vi.fn(), bearer: vi.fn(), signedReach: vi.fn(), bearerReach: vi.fn(),
  status: vi.fn(), authenticateStatus: vi.fn(), rows: vi.fn(),
  config: vi.fn(),
}));
vi.mock('@/src/lib/access/reach-bearer', () => ({
  resolveReachRecipient: mocks.recipient, resolveReachBearer: mocks.bearer,
}));
vi.mock('@/src/lib/auth/agent-reach', () => ({
  reachPrincipal: mocks.signedReach, reachPrincipalWithBearer: mocks.bearerReach,
}));
vi.mock('@/src/lib/auth/reach-status', () => ({ reachStatus: mocks.status }));
vi.mock('@/src/lib/auth/reach-status-auth', async (original) => ({
  ...await original<typeof import('@/src/lib/auth/reach-status-auth')>(),
  authenticateSignedReachStatus: mocks.authenticateStatus,
}));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.rows }) }) }) },
  identities: { id: 'id', handle: 'handle' }, consentGrants: {},
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@/src/lib/jin/front-door', async (original) => ({
  ...await original<typeof import('@/src/lib/jin/front-door')>(),
  readFrontDoorConfig: mocks.config,
}));

const KERNEL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const did = 'did:imajin:ryan';
const base = `/auth/api/agents/${encodeURIComponent(did)}/reach`;
const metadata = {
  privateSentinel: 'NEVER_DISCLOSE_PRIVATE_METADATA',
  agentReachTopics: ['collaboration', 'speaking'],
  agentReachGate: {
    tiers: { anonymous: false, soft: true, preliminary: true, established: false },
    topics: {
      collaboration: { open: true, published: true, mode: 'deliver' },
      speaking: { open: true, published: false, mode: 'deliver' },
      business_development: { open: false, published: false, mode: 'decline' },
    },
    dailyCap: 37,
  },
};
const principal = { id: did, metadata };
type Spec = ReturnType<typeof reachOpenApi>;

function getSpec(handle = 'ryan', authorization?: string) {
  return GET(new NextRequest(`https://untrusted.example/reach/${handle}/openapi.json`, {
    headers: authorization ? { authorization } : {},
  }), { params: Promise.resolve({ handle }) });
}

function post(path: string, body?: unknown, authorization?: string) {
  return new NextRequest(`https://node.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('canonical and opted-in discovery', () => {
  it.each(['ryan', '@ryan', did])('uses the canonical DID card path for %s', async (alias) => {
    const response = await getSpec(alias);
    const spec: Spec = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(spec.paths)).toContain(`/.well-known/agent/${encodeURIComponent(did)}`);
  });

  it.each([
    { tiers: { anonymous: false, soft: false, preliminary: false, established: false }, topics: {}, dailyCap: 25 },
    null,
  ])('withholds disabled or missing reach configuration: %j', async (config) => {
    mocks.config.mockResolvedValue(config);
    mocks.rows.mockResolvedValue([{
      ...principal, handle: 'ryan', name: 'Ryan', scope: 'actor', subtype: 'human',
      metadata: config === null ? {} : { agentReachGate: config },
    }]);
    const response = await getSpec();
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.recipient).not.toHaveBeenCalled();
  });

  it.each([
    { scope: 'community', subtype: 'human' },
    { scope: 'actor', subtype: 'agent' },
    { scope: 'actor', subtype: 'human', suspendedAt: new Date('2026-10-01') },
  ])('withholds discovery for ineligible principals: %j', async (eligibility) => {
    mocks.rows.mockResolvedValue([{ ...principal, handle: 'ryan', name: 'Ryan', ...eligibility }]);
    const response = await getSpec();
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.recipient).not.toHaveBeenCalled();
  });
});

const signed = {
  requesterDid: 'did:web:agent.example', publicKey: 'a'.repeat(64),
  onBehalfOf: { platform: 'muse', externalRef: 'opaque-human' },
  purpose: 'agent.reach', field: 'contact_topics', predicate: 'contains', arg: 'collaboration',
  issuedAt: '2026-10-17T17:30:00Z', signature: 'b'.repeat(128),
};
const delivered = { delivered: true, reachId: 'reach_1' };
const answer = { answer: false, transcriptHash: 'hash', issuedAt: signed.issuedAt };
const receipt = { reachId: 'reach_1', state: 'delivered', reply: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'cwd').mockReturnValue(KERNEL_ROOT);
  vi.stubEnv('APP_URL', 'https://node.example');
  mocks.recipient.mockResolvedValue(principal);
  mocks.rows.mockResolvedValue([{ ...principal, handle: 'ryan', name: 'Ryan', scope: 'actor', subtype: 'human', suspendedAt: null }]);
  mocks.config.mockResolvedValue(metadata.agentReachGate);
  mocks.bearer.mockResolvedValue({ requesterDid: 'did:imajin:foreign_static' });
  mocks.signedReach.mockResolvedValue(answer);
  mocks.bearerReach.mockResolvedValue(delivered);
  mocks.status.mockResolvedValue(receipt);
  mocks.authenticateStatus.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('public reach OpenAPI 3.1', () => {
  it('validates the real served JSON document as OpenAPI 3.1', async () => {
    const response = await getSpec();
    expect(response.status).toBe(200);
    const spec = await response.json();
    expect(spec.openapi).toBe('3.1.0');
    const validated = await SwaggerParser.validate(spec);
    expect(validated.openapi).toBe('3.1.0');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('has exactly the three ruled operations, only real person-bound reach paths and one bearer scheme', async () => {
    const spec: Spec = await (await getSpec()).json();
    expect(Object.keys(spec.paths)).toEqual([
      `/.well-known/agent/${encodeURIComponent(did)}`, base, `${base}/{reachId}/status`,
    ]);
    expect(Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => [path, method, operation.operationId]),
    )).toEqual([
      [`/.well-known/agent/${encodeURIComponent(did)}`, 'get', 'reach_card'],
      [base, 'post', 'reach_ask_send'],
      [`${base}/{reachId}/status`, 'post', 'reach_status'],
    ]);
    expect(spec.servers).toEqual([{ url: 'https://node.example' }]);
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['reachBearer']);
    expect(spec.components.securitySchemes.reachBearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(spec.paths[`/.well-known/agent/${encodeURIComponent(did)}`].get.security).toEqual([]);
    for (const path of [base, `${base}/{reachId}/status`]) {
      expect(spec.paths[path].post.security).toEqual([{ reachBearer: [] }, {}]);
      expect(spec.paths[path].post.description).toMatch(/NOT\s+anonymous/);
    }
    expect(spec.paths[base].post.parameters).toEqual([]);
    expect(spec.paths[`${base}/{reachId}/status`].post.parameters).toEqual([
      { name: 'reachId', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('projects contracts and components from auth.yaml without duplicating their shapes', async () => {
    const source = parse(readFileSync(join(KERNEL_ROOT, 'api-spec/auth.yaml'), 'utf-8'));
    const spec: Spec = await (await getSpec()).json();
    const routes = [
      ['/.well-known/agent/{id}', `/.well-known/agent/${encodeURIComponent(did)}`, 'get', 'app/.well-known/agent/[id]/route.ts'],
      ['/api/agents/{did}/reach', base, 'post', 'app/auth/api/agents/[did]/reach/route.ts'],
      ['/api/agents/{did}/reach/{reachId}/status', `${base}/{reachId}/status`, 'post', 'app/auth/api/agents/[did]/reach/[reachId]/status/route.ts'],
    ];
    for (const [sourcePath, servedPath, method, routeFile] of routes) {
      const original = source.paths[sourcePath][method];
      const operation = spec.paths[servedPath][method];
      expect(operation.responses).toEqual(original.responses);
      expect(operation.requestBody).toEqual(original.requestBody);
      expect(operation.security).toEqual(original.security);
      expect(readFileSync(join(KERNEL_ROOT, routeFile), 'utf-8')).toContain(`export async function ${method.toUpperCase()}`);
    }
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      expect(name.startsWith('Reach')).toBe(true);
      expect(schema).toEqual(source.components.schemas[name]);
    }
    expect(source.info.description).toContain('/reach/{handle}/openapi.json');
  });

  it('reuses published labels and never copies metadata, private topics, policies or unrelated auth schemas', async () => {
    const response = await getSpec();
    const spec: Spec = await response.json();
    expect(spec['x-published-topic-labels']).toEqual(['Collaboration']);
    const text = JSON.stringify(spec);
    for (const hidden of ['NEVER_DISCLOSE_PRIVATE_METADATA', 'speaking', 'Speaking',
      'business_development', 'dailyCap', 'agentReachGate', 'agentReachTopics',
      'cookieAuth', 'internalKeyAuth', 'AUTH_INTERNAL_API_KEY', '/api/health', '/api/grants']) {
      expect(text).not.toContain(hidden);
    }
    const cardResponse = await card(new NextRequest('https://node.example/.well-known/agent/ryan'), {
      params: Promise.resolve({ id: 'ryan' }),
    });
    expect((await cardResponse.json()).reach.topics).toEqual(spec['x-published-topic-labels']);
  });

  it('does not turn published labels into a topic allowlist or disclose legacy unpublished topics', async () => {
    mocks.recipient.mockResolvedValue({ id: did, metadata: { agentReachTopics: ['private-topic'] } });
    const spec: Spec = await (await getSpec()).json();
    expect(spec['x-published-topic-labels']).toEqual([]);
    expect(JSON.stringify(spec.components.schemas)).not.toContain('"enum":["Collaboration"]');
    expect(JSON.stringify(spec)).not.toContain('private-topic');
  });

  it('binds each handle independently and ignores request credentials and untrusted host headers', async () => {
    const first: Spec = await (await getSpec('ryan', 'Bearer invalid')).json();
    mocks.recipient.mockResolvedValue({ id: 'did:imajin:alice', metadata: null });
    mocks.rows.mockResolvedValue([{ id: 'did:imajin:alice', handle: 'alice', name: 'Alice', metadata: null, scope: 'actor', subtype: 'human' }]);
    const second: Spec = await (await getSpec('alice')).json();
    expect(first['x-principal-did']).toBe(did);
    expect(second['x-principal-did']).toBe('did:imajin:alice');
    expect(Object.keys(second.paths)).toContain('/auth/api/agents/did%3Aimajin%3Aalice/reach');
    expect(Object.keys(first.paths)).toContain(base);
    expect(JSON.stringify(second)).not.toContain('ryan');
    expect(JSON.stringify(first)).not.toContain('untrusted.example');
    expect(mocks.bearer).not.toHaveBeenCalled();
    expect(mocks.bearerReach).not.toHaveBeenCalled();
  });

  it('encodes route-bound identifiers instead of interpolating path syntax', () => {
    const spec = reachOpenApi('alias/with?syntax', { id: 'did:imajin:person/segment', metadata: null });
    expect(Object.keys(spec.paths)).toContain('/.well-known/agent/alias%2Fwith%3Fsyntax');
    expect(Object.keys(spec.paths)).toContain('/auth/api/agents/did%3Aimajin%3Aperson%2Fsegment/reach');
  });

  it('returns an uncached 404 for an unknown handle', async () => {
    mocks.recipient.mockResolvedValue(null);
    const response = await getSpec('unknown');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Reach recipient not found' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.recipient).toHaveBeenCalledWith(did);
  });

  it('fails closed and uncached without exposing database errors', async () => {
    mocks.recipient.mockRejectedValue(new Error('PRIVATE DATABASE DETAILS'));
    const response = await getSpec();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Reach specification unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed when the source spec cannot be loaded', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(join(KERNEL_ROOT, 'absent'));
    expect((await getSpec()).status).toBe(503);
  });

  it('offers a public GET preflight without resolving an identity or reading credentials', () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(mocks.recipient).not.toHaveBeenCalled();
  });
});

describe('the documented operations dispatch to the existing handlers', () => {
  it('accepts the documented bearer delivery example at the canonical combined POST', async () => {
    const spec: Spec = await (await getSpec()).json();
    const source = parse(readFileSync(join(KERNEL_ROOT, 'api-spec/auth.yaml'), 'utf-8'));
    const body = source.paths['/api/agents/{did}/reach'].post.requestBody.content['application/json'].examples.bearerDelivery.value;
    expect(spec.paths[base].post.operationId).toBe('reach_ask_send');
    const response = await askSend(post(base, body, 'Bearer synthetic'), { params: Promise.resolve({ did: encodeURIComponent(did) }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(delivered);
    expect(mocks.bearerReach).toHaveBeenCalledWith(did, 'synthetic', body);
    expect(mocks.signedReach).not.toHaveBeenCalled();
  });

  it('accepts signed asks only without Authorization and never falls back from a bad bearer', async () => {
    const response = await askSend(post(base, signed), { params: Promise.resolve({ did }) });
    expect(await response.json()).toEqual(answer);
    expect(mocks.signedReach).toHaveBeenCalledWith(did, signed);
    mocks.signedReach.mockClear();
    mocks.bearerReach.mockResolvedValue({ denied: true, reason: 'unauthorized', status: 401 });
    expect((await askSend(post(base, signed, 'Bearer invalid'), { params: Promise.resolve({ did }) })).status).toBe(401);
    expect(mocks.signedReach).not.toHaveBeenCalled();
  });

  it.each([
    { message: 'Hello' }, { topic: 'collaboration' }, { replyHandle: 'opaque' },
    { message: 'Hello', topic: 'collaboration' },
  ])('documents and rejects incomplete delivery bundles %j', async (bundle) => {
    const source = parse(readFileSync(join(KERNEL_ROOT, 'api-spec/auth.yaml'), 'utf-8'));
    expect(source.components.schemas.ReachDeliveryFields.dependentRequired).toEqual({
      message: ['topic', 'replyHandle'], topic: ['message', 'replyHandle'], replyHandle: ['message', 'topic'],
    });
    const response = await askSend(post(base, { ...signed, ...bundle }), { params: Promise.resolve({ did }) });
    expect(response.status).toBe(400);
    expect(mocks.signedReach).not.toHaveBeenCalled();
  });

  it('matches actual delivery bounds and predicate/topic binding', async () => {
    const source = parse(readFileSync(join(KERNEL_ROOT, 'api-spec/auth.yaml'), 'utf-8'));
    const fields = source.components.schemas.ReachDeliveryFields.properties;
    expect([fields.message.maxLength, fields.topic.maxLength, fields.replyHandle.maxLength]).toEqual([16000, 200, 2000]);
    const body = { ...signed, message: 'Hello', topic: 'other-topic', replyHandle: 'opaque' };
    expect((await askSend(post(base, body), { params: Promise.resolve({ did }) })).status).toBe(400);
    expect(mocks.signedReach).not.toHaveBeenCalled();
  });

  it('accepts bearer status without a body and derives requester identity only from the credential', async () => {
    const response = await status(post(`${base}/reach_1/status`, undefined, 'Bearer synthetic'), {
      params: Promise.resolve({ did, reachId: 'reach_1' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    expect(mocks.bearer).toHaveBeenCalledWith('synthetic', did, 'status');
    expect(mocks.status).toHaveBeenCalledWith({ principalDid: did, reachId: 'reach_1', requesterDid: 'did:imajin:foreign_static' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.authenticateStatus).not.toHaveBeenCalled();
  });

  it('requires and authenticates the documented signed status body without a bearer', async () => {
    const params = { params: Promise.resolve({ did, reachId: 'reach_1' }) };
    expect((await status(post(`${base}/reach_1/status`), params)).status).toBe(400);
    const body = { requesterDid: signed.requesterDid, publicKey: signed.publicKey, issuedAt: signed.issuedAt, signature: signed.signature };
    expect((await status(post(`${base}/reach_1/status`, body), params)).status).toBe(200);
    expect(mocks.authenticateStatus).toHaveBeenCalledWith(did, 'reach_1', body);
    mocks.status.mockClear();
    mocks.bearer.mockResolvedValue(null);
    expect((await status(post(`${base}/reach_1/status`, body, 'Bearer invalid'), params)).status).toBe(401);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
