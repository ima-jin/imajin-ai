import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto as authCrypto, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';
import { defaultFrontDoorConfig } from '@/src/lib/jin/front-door';
import { reachTranscript, type ReachRequestInput } from '@/src/lib/auth/agent-reach';
import { POST } from '../route';

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  envelopes: new Map<string, Record<string, unknown>>(),
  attest: vi.fn(), publish: vi.fn(), broker: vi.fn(), grant: vi.fn(),
  persist: vi.fn(), limit: vi.fn(), node: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) },
}));
vi.mock('@/src/lib/http/node-url', () => ({ agentCardUrl: () => 'https://imajin.ai/.well-known/agent.json' }));
vi.mock('drizzle-orm', async (original) => ({
  ...await original<typeof import('drizzle-orm')>(),
  eq: (_column: unknown, value: string) => value,
}));
vi.mock('@/src/db', () => ({
  identities: { id: 'id', metadata: 'metadata', tier: 'tier', publicKey: 'publicKey' },
  consentGrants: {},
  db: {
    select: selectRows,
  },
}));

function selectRows() {
  return { from: () => ({ where: findRows }) };
}

function findRows(id: string) {
  return { limit: () => Promise.resolve(mocks.rows.has(id) ? [mocks.rows.get(id)] : []) };
}
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(),
  emitAttestation: (...args: unknown[]) => mocks.attest(...args),
}));
vi.mock('@imajin/config', async (original) => ({
  ...await original<typeof import('@imajin/config')>(),
  rateLimit: (...args: unknown[]) => mocks.limit(...args),
}));
vi.mock('@imajin/bus', () => ({
  broker: (...args: unknown[]) => mocks.broker(...args),
  publish: (...args: unknown[]) => mocks.publish(...args),
  isBrokerRelease: (result: { status: string }) => result.status === 'released',
}));
vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: (...args: unknown[]) => mocks.grant(...args) }));
vi.mock('@/src/lib/auth/foreign-principal-stub', () => ({
  resolveOrMintForeignPrincipalStub: async () => ({ did: 'did:imajin:foreign-human-stub' }),
}));
vi.mock('@/src/lib/auth/reach-envelope-store', () => ({
  persistReachEnvelope: (...args: unknown[]) => mocks.persist(...args),
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: () => mocks.node() }));

const principalDid = 'did:imajin:ryan';
const requesterDid = 'did:imajin:sender';
const senderKey = authCrypto.generateKeypair();
const nodeKey = authCrypto.generateKeypair();
const nodeDid = authCrypto.createDID(nodeKey.publicKey);

function signedBody(patch: Partial<ReachRequestInput> = {}): ReachRequestInput {
  const input: ReachRequestInput = {
    requesterDid, onBehalfOf: { platform: 'test', externalRef: 'human-opaque' },
    purpose: 'agent.reach', field: 'contact_topics', predicate: 'contains', arg: 'business_development',
    message: 'A full private message for Ryan', topic: 'business_development', replyHandle: 'caller:own-thread',
    issuedAt: new Date().toISOString(), signature: '', ...patch,
  };
  input.signature = authCrypto.signSync(reachTranscript(principalDid, input), senderKey.privateKey);
  return input;
}

async function post(body: unknown) {
  return POST({ json: async () => body } as never, { params: Promise.resolve({ did: principalDid }) }) as unknown as Promise<{
    status: number; body: Record<string, unknown>;
  }>;
}

function setTopic(patch: Record<string, unknown> = {}) {
  const config = defaultFrontDoorConfig();
  config.tiers.established = true;
  config.topics.business_development = { open: true, published: true, mode: 'deliver', ...patch };
  mocks.rows.set(principalDid, { id: principalDid, metadata: { agentReachGate: config, agentReachTopics: ['business_development'] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.envelopes.clear();
  setTopic();
  mocks.rows.set(requesterDid, { id: requesterDid, publicKey: senderKey.publicKey, tier: 'established' });
  mocks.attest.mockResolvedValue({ attestationId: 'att_test' });
  mocks.publish.mockResolvedValue({});
  mocks.broker.mockResolvedValue({ status: 'released', data: { contact_topics: { result: true } } });
  mocks.grant.mockResolvedValue({ authorized: true, grantId: 'grant_test' });
  mocks.limit.mockReturnValue({ limited: false, retryAfter: 0 });
  mocks.node.mockReturnValue({ senderDid: nodeDid, senderPubkey: nodeKey.publicKey, privateKeyHex: nodeKey.privateKey });
  mocks.persist.mockImplementation(async (envelope: Record<string, unknown>) => {
    mocks.envelopes.set(String(envelope.reachId), envelope);
    return { stored: true, reachId: envelope.reachId };
  });
});

describe('signed reach delivery through POST', () => {
  it('stores full body, publishes a verifiable principal-addressed event, and attests only once', async () => {
    const input = signedBody();
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ delivered: true, reachId: expect.stringMatching(/^reach_/) });
    const stored = mocks.envelopes.get(String(response.body.reachId));
    expect(stored).toMatchObject({ message: input.message, replyHandle: input.replyHandle, requesterDid, principalDid });
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const [type, event] = mocks.publish.mock.calls[0];
    expect(type).toBe('agent.reach.delivered');
    expect(event).toMatchObject({ issuer: nodeDid, subject: principalDid, scope: 'agent', payload: {
      source: 'reach', claimVerified: false, requesterTier: 'established', message: input.message,
      replyHandle: input.replyHandle, transcriptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    } });
    const { signature, ...unsignedPayload } = event.payload;
    const transcript = canonicalize({ type, issuer: event.issuer, subject: event.subject, scope: event.scope, payload: unsignedPayload });
    expect(authCrypto.verifySync(signature.sig, transcript, signature.keyId)).toBe(true);
    expect(authCrypto.verifySync(signature.sig, canonicalize({
      type, issuer: event.issuer, subject: 'did:imajin:other', scope: event.scope, payload: unsignedPayload,
    }), signature.keyId)).toBe(false);
    expect(stored?.signedEvent).toEqual({ type, ...event });
    expect(mocks.attest).toHaveBeenCalledTimes(1);
    expect(mocks.attest.mock.calls[0][0].payload).toMatchObject({ outcome: 'delivered', reachId: response.body.reachId });
    expect(JSON.stringify(mocks.attest.mock.calls)).not.toContain(input.message);
  });

  it.each([{ published: false }, { open: false }, { mode: 'decline' }])('returns existing false-answer shape without storing a body for %j', async (patch) => {
    setTopic(patch);
    const response = await post(signedBody());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ answer: false, transcriptHash: expect.any(String), issuedAt: expect.any(String) });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.attest).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith('agent.reach.answered', expect.anything());
  });

  it('preserves broker-deny shape and stores no body', async () => {
    mocks.broker.mockResolvedValue({ status: 'rejected' });
    expect((await post(signedBody())).body.answer).toBe(false);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.attest).toHaveBeenCalledTimes(1);
  });

  it('answers an unknown topic with the same false-answer shape and stores no body', async () => {
    const response = await post(signedBody({ topic: 'unpublished-unknown', arg: 'unpublished-unknown' }));
    expect(response.body).toEqual({ answer: false, transcriptHash: expect.any(String), issuedAt: expect.any(String) });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.attest).toHaveBeenCalledTimes(1);
  });

  it.each(['message', 'topic', 'replyHandle'] as const)('verifies the signature over %s, refusing tampering before storage', async (field) => {
    const body = signedBody();
    if (field === 'topic') {
      body.topic = 'collaboration';
      body.arg = 'collaboration';
    } else body[field] += '-tampered';
    expect((await post(body)).body.error).toBe('invalid_signature');
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.attest).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Date(Date.now() - SIGNED_MESSAGE_MAX_AGE - 10_000).toISOString(),
    new Date(Date.now() + FUTURE_TOLERANCE + 10_000).toISOString(),
  ])('rejects stale or future signed delivery %s', async (issuedAt) => {
    expect((await post(signedBody({ issuedAt }))).status).toBe(401);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('applies the canonical per-authenticated-sender burst limiter before persistence', async () => {
    mocks.limit.mockReturnValue({ limited: true, retryAfter: 60 });
    const response = await post(signedBody());
    expect(response.status).toBe(429);
    expect(response.body.error).toBe('rate_limited');
    expect(mocks.limit).toHaveBeenCalledWith(`reach:send:${principalDid}:${requesterDid}`, 5, 60_000);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.attest).toHaveBeenCalledTimes(1);
  });

  it.each(['rate_limited', 'blocked'])('refuses durable store policy %s without delivery', async (reason) => {
    mocks.persist.mockResolvedValue({ stored: false, reason });
    const response = await post(signedBody());
    expect(response.status).toBe(reason === 'blocked' ? 403 : 429);
    expect(mocks.envelopes.size).toBe(0);
    expect(mocks.attest).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalledWith('agent.reach.delivered', expect.anything());
  });

  it('does not recreate delivery or attestation on a stored transcript replay', async () => {
    mocks.persist.mockResolvedValue({ stored: true, reachId: 'reach_original', replayed: true });
    expect((await post(signedBody())).body).toEqual({ delivered: true, reachId: 'reach_original' });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.attest).not.toHaveBeenCalled();
  });

  it('never claims delivery when persistence fails', async () => {
    mocks.persist.mockRejectedValue(new Error('database unavailable'));
    await expect(post(signedBody())).rejects.toThrow('database unavailable');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('keeps legacy boolean-only requests valid without persisting or delivering', async () => {
    const input = signedBody({ message: undefined, topic: undefined, replyHandle: undefined });
    expect((await post(input)).body.answer).toBe(true);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.attest).toHaveBeenCalledTimes(1);
  });
});
