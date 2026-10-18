import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), select: vi.fn(), insert: vi.fn(), values: vi.fn(),
  grant: vi.fn(), customer: vi.fn(), prepare: vi.fn(), email: vi.fn(),
  rateLimit: vi.fn(), error: vi.fn(),
}));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppServiceToken: mocks.verify }));
vi.mock('@/src/lib/auth/app-authorization-grant', () => ({ hasAppAuthorizationGrant: mocks.grant }));
vi.mock('@/src/lib/stripe/byo-checkout', () => ({ retrieveByoCheckoutCustomer: mocks.customer }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: mocks.prepare }));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: mocks.email }));
vi.mock('nanoid', () => ({ nanoid: (length: number) => `test-fixture-${length}` }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: mocks.error }) }));
vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.example' }),
  buildPublicUrlAbsolute: () => 'https://kernel.example/auth',
  rateLimit: mocks.rateLimit,
}));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/pay'),
  ...await import('@/src/db/schemas/registry'),
  db: { select: mocks.select, insert: mocks.insert },
}));

import { POST } from '../route';
import { attestations, credentials, onboardTokens } from '@/src/db';

const appDid = 'did:imajin:events-app';
const ownerDid = 'did:imajin:organizer';
const buyerDid = 'did:imajin:buyer';
const registered = { appDid, ownerDid, name: `Owner <Org> & "Team"'`, status: 'active', approved: ['onboard:send'] };
const order = {
  id: 'tx_order', appDid, toDid: ownerDid, fromDid: buyerDid,
  status: 'completed', rail: 'stripe-byo', externalRef: 'cs_order',
  metadata: { customer_email: 'attacker@example.com', buyerDid: 'did:imajin:stranger' },
};
const signedRecord = { id: 'att_send', issuerDid: 'did:imajin:node', signature: 'test-signature' };
const whereCalls: unknown[] = [];

function rows(result: unknown[]) {
  return { from: vi.fn().mockReturnValue({
    where: vi.fn((predicate: unknown) => {
      whereCalls.push(predicate);
      const selection = { limit: vi.fn().mockResolvedValue(result), orderBy: vi.fn() };
      selection.orderBy.mockReturnValue(selection);
      return selection;
    }),
  }) };
}
function request(body: unknown = { transactionId: order.id }, authorization: string | null = 'Bearer fixture.jwt.value') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorization) headers.Authorization = authorization;
  return new NextRequest('https://kernel.example/auth/api/onboard/send', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}
function setupOrder(value: unknown = order, credential: unknown = { email: 'BUYER@example.com' }) {
  mocks.select.mockReset()
    .mockReturnValueOnce(rows([registered]))
    .mockReturnValueOnce(rows(value ? [value] : []))
    .mockReturnValueOnce(rows(credential ? [credential] : []));
}
beforeEach(() => {
  vi.resetAllMocks();
  whereCalls.length = 0;
  mocks.verify.mockResolvedValue({ appDid, scopes: ['onboard:send'] });
  mocks.grant.mockResolvedValue(false);
  mocks.prepare.mockResolvedValue(signedRecord);
  mocks.email.mockResolvedValue({ success: true });
  mocks.rateLimit.mockReturnValue({ limited: false });
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockResolvedValue(undefined);
  mocks.customer.mockResolvedValue({ email: 'guest@example.com', name: 'Guest' });
  setupOrder();
});

describe('kernel-private order onboarding', () => {
  describe('verified credential ordering', () => {
    const client = new PGlite();
    const contactDb = drizzle(client);
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-02-01T00:00:00Z');

    beforeAll(async () => {
      await client.exec(`
        CREATE SCHEMA auth;
        CREATE TABLE auth.credentials (
          id text PRIMARY KEY, did text NOT NULL, type text NOT NULL,
          value text NOT NULL, verified_at timestamptz, created_at timestamptz DEFAULT now()
        );
      `);
    });
    afterAll(async () => { await client.close(); });

    it.each([
      { label: 'most recently verified', first: older, second: newer, firstId: 'cred_a', secondId: 'cred_z', expected: 'second@example.com' },
      { label: 'stable credential id on equal verification times', first: newer, second: newer, firstId: 'cred_z', secondId: 'cred_a', expected: 'second@example.com' },
      { label: 'verified over unverified', first: null, second: older, firstId: 'cred_a', secondId: 'cred_z', expected: 'second@example.com' },
      { label: 'no fallback to unverified', first: null, second: null, firstId: 'cred_a', secondId: 'cred_z', expected: null },
    ])('chooses $label from two stored emails', async ({ first, second, firstId, secondId, expected }) => {
      await contactDb.delete(credentials);
      // Insert the losing candidate first, with a lower ID except in the tie case.
      await contactDb.insert(credentials).values([
        { id: firstId, did: buyerDid, type: 'email', value: 'first@example.com', verifiedAt: first },
        { id: secondId, did: buyerDid, type: 'email', value: 'second@example.com', verifiedAt: second },
      ]);
      mocks.select.mockReset()
        .mockReturnValueOnce(rows([registered]))
        .mockReturnValueOnce(rows([order]))
        .mockReturnValueOnce(contactDb.select({ email: credentials.value }));

      const response = await POST(request());

      expect(response.status).toBe(expected ? 200 : 404);
      if (expected) {
        expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ to: expected }));
      } else {
        expect(mocks.email).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
      }
      expect(mocks.customer).not.toHaveBeenCalled();
    });
  });
  it('emails only the kernel credential, stores the ordinary token and returns status only', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'sent' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(mocks.verify).toHaveBeenCalledWith('fixture.jwt.value');
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'signin', sensitive: true, appDid, ownerDid,
      to: 'buyer@example.com',
      html: expect.stringContaining('/auth/api/onboard/verify?token=test-fixture-48'),
    }));
    expect(mocks.email.mock.calls[0][0].html).toContain('Owner &lt;Org&gt; &amp; &quot;Team&quot;&#39;');
    expect(mocks.values).toHaveBeenNthCalledWith(2, expect.objectContaining({
      email: 'buyer@example.com', token: 'test-fixture-48',
      pollHandle: null, scopeDid: null, inviteCode: null,
      redirectUrl: 'https://kernel.example/auth',
      expiresAt: expect.any(Date),
    }));
    expect(mocks.insert).toHaveBeenNthCalledWith(1, attestations);
    expect(mocks.insert).toHaveBeenNthCalledWith(2, onboardTokens);
    expect(mocks.prepare).toHaveBeenCalledWith({
      subjectDid: appDid, type: 'onboard.link.sent', contextId: order.id, contextType: 'order',
      payload: { onBehalfOf: appDid, ownerDid, transactionId: order.id, delivery: 'email', requestId: signedRecord.id },
    });
    expect(mocks.insert).toHaveBeenNthCalledWith(3, attestations);
    expect(mocks.values).toHaveBeenLastCalledWith(signedRecord);
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.email.mock.invocationCallOrder[0]);
    expect(mocks.insert.mock.invocationCallOrder[0]).toBeLessThan(mocks.email.mock.invocationCallOrder[0]);
    expect(mocks.email.mock.invocationCallOrder[0]).toBeLessThan(mocks.insert.mock.invocationCallOrder[2]);
    expect(mocks.customer).not.toHaveBeenCalled();

    const dialect = new PgDialect();
    const queries = whereCalls.map((where) => dialect.sqlToQuery(where as Parameters<typeof dialect.sqlToQuery>[0]));
    expect(queries[1].sql).toContain('"pay"."transactions"."app_did" =');
    expect(queries[1].params).toEqual([order.id, appDid, 'completed', 'stripe-byo']);
    expect(queries[2].sql).toContain('"auth"."credentials"."verified_at" is not null');
    expect(queries[2].params).toEqual([buyerDid, 'email']);
  });

  it('uses the recorded seller rail for an anonymous buyer, never checkout metadata', async () => {
    setupOrder({ ...order, fromDid: null });
    const response = await POST(request());
    expect(await response.json()).toEqual({ status: 'sent' });
    expect(mocks.customer).toHaveBeenCalledWith(ownerDid, 'cs_order');
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ to: 'guest@example.com' }));
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  it('permits another owner only with a live owner-specific authorization', async () => {
    setupOrder({ ...order, toDid: 'did:imajin:delegating-org' });
    mocks.grant.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith(appDid, 'did:imajin:delegating-org', 'onboard:send');
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'signin', sensitive: true, appDid, ownerDid,
    }));
  });

  it.each([
    ['cross-app', { ...order, appDid: 'did:imajin:other-app' }],
    ['legacy unbound', { ...order, appDid: null }],
    ["stranger's order", null],
    ['pending', { ...order, status: 'pending' }],
    ['refunded', { ...order, status: 'refunded' }],
    ['unrelated rail', { ...order, rail: 'internal' }],
    ['direct charge', { ...order, externalRef: 'pi_charge' }],
    ['missing session', { ...order, externalRef: null }],
    ['cross-owner', { ...order, toDid: 'did:imajin:stranger' }],
  ])('refuses %s without reading contact or minting/sending', async (_label, value) => {
    setupOrder(value);
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Order unavailable' });
    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
  });

  it.each([null, { email: 'not-an-email' }])('never falls back to billing metadata for a known buyer', async (credential) => {
    setupOrder(order, credential);
    expect((await POST(request())).status).toBe(404);
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
  });

  it('refuses a guest whose rail has no buyer email', async () => {
    setupOrder({ ...order, fromDid: null });
    mocks.customer.mockResolvedValue({ email: null });
    expect((await POST(request())).status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    { transactionId: order.id, email: 'attacker@example.com' },
    { transactionId: order.id, buyerDid: 'did:imajin:stranger' },
    { transactionId: order.id, ownerDid: 'did:imajin:stranger' },
    { transactionId: order.id, redirectUrl: 'https://attacker.example' },
    { transactionId: order.id, wantPolling: true },
    { transactionId: '' }, null, [], { orderId: 'standalone-order' },
  ])('rejects unsupported input without resource or contact reads: %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const req = request();
    vi.spyOn(req, 'json').mockRejectedValue(new SyntaxError('bad JSON'));
    expect((await POST(req)).status).toBe(400);
  });

  it.each([null, 'legacy-shared-key', 'Basic fixture'])('refuses missing/non-service auth %s', async (auth) => {
    expect((await POST(request(undefined, auth))).status).toBe(401);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('refuses a credential rejected by the strict service verifier', async () => {
    mocks.verify.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('requires the token scope as well as live approval', async () => {
    mocks.verify.mockResolvedValue({ appDid, scopes: [] });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each([
    { result: [] }, { result: [{ ...registered, status: 'revoked' }] },
    { result: [{ ...registered, approved: [] }] }, { result: [{ ...registered, approved: null }] },
  ])('refuses revoked/missing registration or approval', async ({ result }) => {
    mocks.select.mockReset().mockReturnValueOnce(rows(result));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])('limits app/resource/recipient at stage %s without minting', async (stage) => {
    mocks.rateLimit.mockImplementation(() => ({ limited: false }));
    for (let i = 0; i < stage; i++) mocks.rateLimit.mockReturnValueOnce({ limited: false });
    mocks.rateLimit.mockReturnValueOnce({ limited: true, retryAfter: 60 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('does not record a sent event when the mail provider refuses delivery', async () => {
    mocks.email.mockResolvedValue({ success: false, error: 'sensitive provider details' });
    expect((await POST(request())).status).toBe(502);
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each(['registry', 'signer', 'intent', 'provider', 'audit', 'rail', 'owner grant'])('redacts %s failures', async (stage) => {
    const failure = new Error('private email / bearer / verify URL');
    if (stage === 'registry') mocks.select.mockReset().mockImplementationOnce(() => { throw failure; });
    if (stage === 'signer') mocks.prepare.mockRejectedValue(failure);
    if (stage === 'provider') mocks.email.mockRejectedValue(failure);
    if (stage === 'intent') mocks.values.mockRejectedValueOnce(failure);
    if (stage === 'audit') {
      mocks.values.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    }
    if (stage === 'rail') {
      setupOrder({ ...order, fromDid: null });
      mocks.customer.mockRejectedValue(failure);
    }
    if (stage === 'owner grant') {
      setupOrder({ ...order, toDid: 'did:imajin:other-owner' });
      mocks.grant.mockRejectedValue(failure);
    }
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Onboarding delivery unavailable' });
    expect(mocks.error).toHaveBeenCalledWith(
      { status: 503, code: 'ONBOARD_DELIVERY_UNAVAILABLE' }, 'Order onboarding delivery unavailable',
    );
    if (stage === 'signer' || stage === 'intent') expect(mocks.email).not.toHaveBeenCalled();
  });
});
