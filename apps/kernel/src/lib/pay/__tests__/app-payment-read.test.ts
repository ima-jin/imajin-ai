import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { parse } from 'yaml';
import { isServiceEligibleScope, validateScopes } from '@imajin/auth';
import { createPgliteLedgerHarness, type PgliteLedgerHarness } from './pglite-pay-harness';

const h = vi.hoisted(() => ({
  select: vi.fn(),
  tokens: new Map<string, Record<string, unknown>>(),
  rateLimit: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/src/db', async () => ({
  db: { select: h.select },
  ...await import('@/src/db/schemas/pay'),
  ...await import('@/src/db/schemas/registry'),
}));
vi.mock('@/src/lib/auth/jwt', () => ({
  verifyAppToken: async (token: string) => h.tokens.get(token) ?? null,
}));
vi.mock('@imajin/config', () => ({ rateLimit: h.rateLimit }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: h.error }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://events.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

import { POST, OPTIONS } from '../../../../app/pay/api/transactions/lookup/route';
import { parsePaymentLookup, PAY_READ_SCOPE } from '../app-payment-read';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const APP = 'did:imajin:events-app';
const OTHER_APP = 'did:imajin:other-app';
const SELLER = 'did:imajin:seller';
const OTHER_SELLER = 'did:imajin:other-seller';
const BODY = { sellerDid: SELLER, sessionIds: ['cs_order'] };
let harness: PgliteLedgerHarness;

function request(body: unknown = BODY, authorization: string | null = 'Bearer app-service') {
  return new NextRequest('https://kernel.test/pay/api/transactions/lookup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'imajin_session=test-user-session',
      ...(authorization === null ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify(body),
  });
}

async function seed(id = 'tx_order', overrides: {
  appDid?: string | null; sellerDid?: string; sessionId?: string | null;
  rail?: string | null; metadata?: unknown; status?: string;
} = {}) {
  const {
    appDid = APP, sellerDid = SELLER, sessionId = 'cs_order',
    rail = 'stripe-byo', metadata = { orderId: 'ord_1', eventId: 'evt_1' }, status = 'completed',
  } = overrides;
  await harness.client.query(
    `INSERT INTO pay.transactions
      (id, service, type, to_did, amount, currency, status, app_did, rail, external_ref, metadata)
     VALUES ($1, 'events', 'ticket', $2, '10.00', 'CAD', $3, $4, $5, $6, $7::jsonb)`,
    [id, sellerDid, status, appDid, rail, sessionId, JSON.stringify(metadata)],
  );
}

async function registration(values: { status?: string; approved?: string[] } = {}) {
  await harness.client.query(
    'UPDATE registry.apps SET status = $1, approved_service_scopes = $2::jsonb WHERE app_did = $3',
    [values.status ?? 'active', JSON.stringify(values.approved ?? [PAY_READ_SCOPE]), APP],
  );
}

beforeAll(async () => {
  harness = await createPgliteLedgerHarness();
  for (const migration of ['0007_registry_apps.sql', '0179_registry_apps_approved_service_scopes.sql']) {
    await harness.client.exec(readFileSync(new URL(`../../../../../../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  for (const appDid of [APP, OTHER_APP]) {
    await harness.client.query(
      `INSERT INTO registry.apps (id, app_did, owner_did, name, public_key, callback_url, status, approved_service_scopes)
       VALUES ($1, $1, 'did:imajin:owner', 'test app', 'test-public-key', 'https://app.test', 'active', '["pay:read"]')`,
      [appDid],
    );
  }
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  h.select.mockImplementation((fields) => harness.connA.select(fields));
  h.rateLimit.mockReturnValue({ limited: false });
  h.tokens.clear();
  h.tokens.set('app-service', { azp: APP, isServiceToken: true, scope: PAY_READ_SCOPE });
  h.tokens.set('other-app', { azp: OTHER_APP, isServiceToken: true, scope: PAY_READ_SCOPE });
  await harness.client.exec('TRUNCATE pay.transactions');
  await registration();
});

describe('registered-app payment reads (#2540)', () => {
  it('returns the kernel payment ID and safe order metadata without writing anything', async () => {
    await seed();
    const before = await harness.client.query('SELECT * FROM pay.transactions');
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://events.test');
    expect(await response.json()).toEqual({
      transactions: [{ transactionId: 'tx_order', sessionId: 'cs_order', metadata: { orderId: 'ord_1', eventId: 'evt_1' } }],
    });
    expect((await harness.client.query('SELECT * FROM pay.transactions')).rows).toEqual(before.rows);
    expect(h.rateLimit).toHaveBeenCalledWith(`pay:read:${APP}`, 60, 60_000);
  });

  it('filters a mixed batch by real app, seller, rail and session predicates, not metadata', async () => {
    await seed();
    await seed('tx_other_app', { appDid: OTHER_APP, sessionId: 'cs_foreign', metadata: { appDid: APP } });
    await seed('tx_unbound', { appDid: null, sessionId: 'cs_legacy', metadata: { appDid: APP, sellerDid: SELLER } });
    await seed('tx_other_seller', { sellerDid: OTHER_SELLER, sessionId: 'cs_seller', metadata: { sellerDid: SELLER } });
    await seed('tx_wrong_rail', { rail: 'solana', sessionId: 'cs_rail' });
    await seed('tx_null_rail', { rail: null, sessionId: 'cs_no_rail' });
    await seed('tx_unrequested', { sessionId: 'cs_unrequested' });
    await seed('tx_intent', { sessionId: 'pi_hidden' });
    const response = await POST(request({
      ...BODY, appDid: OTHER_APP, toDid: OTHER_SELLER,
      sessionIds: ['cs_order', 'cs_foreign', 'cs_legacy', 'cs_seller', 'cs_rail', 'cs_no_rail', 'cs_missing'],
    }));
    expect((await response.json()).transactions.map((row: { transactionId: string }) => row.transactionId)).toEqual(['tx_order']);
  });

  it('cannot read another app even with a valid approved app-service credential', async () => {
    await seed();
    const response = await POST(request(BODY, 'Bearer other-app'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transactions: [] });
  });

  it('isolates identical session references on different seller accounts', async () => {
    await seed();
    await seed('tx_wrong_seller', { sellerDid: OTHER_SELLER });
    const response = await POST(request());
    expect((await response.json()).transactions.map((row: { transactionId: string }) => row.transactionId)).toEqual(['tx_order']);
  });

  it('omits a wrong seller exactly like an unknown session', async () => {
    await seed();
    const wrongSeller = await POST(request({ ...BODY, sellerDid: OTHER_SELLER }));
    const missing = await POST(request({ ...BODY, sessionIds: ['cs_unknown'] }));
    expect(await wrongSeller.json()).toEqual(await missing.json());
  });

  it.each(['pending', 'failed', 'completed', 'refunded', 'partially_refunded'])('reads %s metadata without claiming payment success', async (status) => {
    await seed('tx_order', { status });
    expect((await (await POST(request())).json()).transactions).toHaveLength(1);
  });

  it('supports app-bound legacy Stripe rails and deduplicates inputs with stable transaction ordering', async () => {
    await seed('tx_z', { rail: 'stripe', sessionId: 'cs_z' });
    await seed('tx_a', { sessionId: 'cs_a' });
    await seed('tx_a2', { sessionId: 'cs_a' });
    const response = await POST(request({ ...BODY, sessionIds: ['cs_z', 'cs_a', 'cs_a'] }));
    expect((await response.json()).transactions.map((row: { transactionId: string }) => row.transactionId)).toEqual(['tx_a', 'tx_a2', 'tx_z']);
  });

  it('withholds provider IDs, secrets, PII, manifests and nested or oversized allowlisted values', async () => {
    await seed('tx_order', { metadata: {
      orderId: 'ord_1', order_id: 'ord_legacy', eventId: 'evt_1', event_id: 'evt_legacy', service: 'events', type: 'ticket',
      clientSecret: 'redaction-fixture', payment_method: 'pm_redactionfixture', customerId: 'cus_redactionfixture',
      settledPaymentIntentId: 'pi_redactionfixture', card: { last4: '0000' }, customer_email: 'private@example.test',
      fairManifest: { chain: [] }, unknown: { nested: true },
    } });
    const response = await POST(request());
    expect(await response.json()).toEqual({ transactions: [{
      transactionId: 'tx_order', sessionId: 'cs_order',
      metadata: { orderId: 'ord_1', order_id: 'ord_legacy', eventId: 'evt_1', event_id: 'evt_legacy', service: 'events', type: 'ticket' },
    }] });
    await harness.client.exec('TRUNCATE pay.transactions');
    await seed('tx_order', { metadata: { orderId: { clientSecret: 'redaction-fixture' }, eventId: ['evt'], type: 123, service: 'x'.repeat(201) } });
    expect((await (await POST(request())).json()).transactions[0].metadata).toEqual({});
  });

  it.each([null, [], 'malformed'])('safely handles legacy metadata %j', async (metadata) => {
    await seed('tx_order', { metadata });
    expect((await (await POST(request())).json()).transactions[0].metadata).toEqual({});
  });

  it.each([null, 'Basic not-a-token', 'Bearer invalid', 'Bearer expired', 'Bearer retired-shared-key'])('rejects missing/invalid credentials %s even with a session cookie', async (authorization) => {
    expect((await POST(request(BODY, authorization))).status).toBe(401);
    expect(h.select).not.toHaveBeenCalled();
  });

  it.each([
    { isServiceToken: false, azp: APP, scope: PAY_READ_SCOPE },
    { isServiceToken: true, scope: PAY_READ_SCOPE },
    { isServiceToken: true, azp: APP, scope: 'pay:settle' },
    { isServiceToken: true, azp: APP, scope: '' },
  ])('rejects delegated, unbound or wrongly scoped claims %j', async (claims) => {
    h.tokens.set('app-service', claims);
    expect((await POST(request())).status).toBe(403);
    expect(h.select).not.toHaveBeenCalled();
  });

  it('rechecks approval and app status on every call, even with the same token', async () => {
    await seed();
    expect((await POST(request())).status).toBe(200);
    await registration({ approved: [] });
    expect((await POST(request())).status).toBe(403);
    await registration({ status: 'revoked' });
    expect((await POST(request())).status).toBe(403);
    h.tokens.set('app-service', { azp: 'did:imajin:unregistered', isServiceToken: true, scope: PAY_READ_SCOPE });
    expect((await POST(request())).status).toBe(403);
  });

  it('requires operator approval rather than making the scope globally service-eligible', () => {
    expect(validateScopes([PAY_READ_SCOPE])).toEqual({ valid: [PAY_READ_SCOPE], invalid: [] });
    expect(isServiceEligibleScope(PAY_READ_SCOPE)).toBe(false);
  });

  it('returns 400 for malformed JSON after authenticating', async () => {
    const malformed = request();
    vi.spyOn(malformed, 'json').mockRejectedValue(new SyntaxError('invalid JSON'));
    expect((await POST(malformed)).status).toBe(400);
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, [], 'body', {}, { ...BODY, sellerDid: null }, { ...BODY, sellerDid: 'seller' },
    { ...BODY, sellerDid: `did:imajin:${'x'.repeat(500)}` },
    { ...BODY, sessionIds: null }, { ...BODY, sessionIds: [] },
    { ...BODY, sessionIds: Array.from({ length: 101 }, () => 'cs_order') },
    ...[null, 1, '', 'cs_', 'csX_not_a_session', 'pi_intent', "cs_';SELECT", `cs_${'x'.repeat(255)}`]
      .map((id) => ({ ...BODY, sessionIds: [id] })),
  ])('rejects invalid input before payment SQL: %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 100 valid sessions and deduplicates the SQL inputs', async () => {
    const body = { ...BODY, sessionIds: Array.from({ length: 100 }, () => 'cs_order') };
    expect(parsePaymentLookup(body)).toEqual(BODY);
    expect((await POST(request(body))).status).toBe(200);
  });

  it('returns a safe 429 before payment lookup', async () => {
    h.rateLimit.mockReturnValue({ limited: true, retryAfter: 12 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('12');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('fails closed without disclosing internal details when query %s fails', async (successfulQueries) => {
    h.select.mockReset();
    for (let index = 0; index < successfulQueries; index++) {
      h.select.mockImplementationOnce((fields) => harness.connA.select(fields));
    }
    h.select.mockImplementation(() => { throw new Error('internal-private-database-detail'); });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Payment lookup unavailable' });
    expect(JSON.stringify(h.error.mock.calls)).not.toContain('internal-private');
  });

  it('exports CORS preflight and documents the exact allowlisted contract', async () => {
    expect(OPTIONS().status).toBe(204);
    const spec = parse(readFileSync(new URL('../../../../api-spec/pay.yaml', import.meta.url), 'utf8'));
    const route = spec.paths['/api/transactions/lookup'].post;
    expect(route.security).toEqual([{ appServiceToken: [] }]);
    expect(route.requestBody.content['application/json'].schema.properties.sessionIds.maxItems).toBe(100);
    const result = route.responses['200'].content['application/json'].schema.properties.transactions.items;
    expect(Object.keys(result.properties)).toEqual(['transactionId', 'sessionId', 'metadata']);
    expect(result.properties.metadata.additionalProperties).toBe(false);
  });
});
