/**
 * POST /api/campaign/pledge and POST /api/campaign/pledge/confirm — the backer
 * side of a crowdfunding campaign: create a Stripe SetupIntent through the pay
 * service, then confirm it. Shared mocks / blocks live in
 * support/campaign-route-support.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKER_DID,
  CREATOR_DID,
  ERR_EVENT_ID_REQUIRED,
  ERR_EVENT_NOT_FOUND,
  ERR_NOT_CAMPAIGN,
  EVENT_ID,
  campaignJsonRequest,
  expectCors,
  itAnswers500WhenHandlerThrows,
  itAnswersPreflight,
  itRateLimits,
  itRejectsUnauthenticated,
  makeEvent,
  makePledge,
  resetCampaignMocks,
  signInAs,
} from './support/campaign-route-support';
import { insertMock, nextInsert, nextSelect, nextUpdate, selectMock, setValues, updatedTables, valuesMock, whereParams } from './support/db-queue-support';
import { fetchMock, jsonResponse, payUrl, textResponse } from './support/kernel-mock-support';
import { mockLog } from './support/route-test-support';
import { pledges } from '@/src/db';
import { SETUP_INTENT_CONTRACT } from '../lib/pledge-payment';

const tokenMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/pay-app-token', () => ({ getPayAppToken: tokenMock, invalidatePayAppToken: vi.fn() }));
import { OPTIONS as pledgeOptions, POST as postPledge } from '../../app/api/campaign/pledge/route';
import { OPTIONS as confirmOptions, POST as postConfirm } from '../../app/api/campaign/pledge/confirm/route';

const PLEDGE_PATH = 'pledge';
const CONFIRM_PATH = 'pledge/confirm';
const COOKIE = 'session=abc';
const ERR_PLEDGE_FAILED = 'Failed to create pledge';
const ERR_CONFIRM_FAILED = 'Failed to confirm pledge';
const ERR_AMOUNT = 'amount must be an integer >= 100 (minimum $1.00)';
const SETUP_INTENT = { clientSecret: 'seti_secret', setupIntentId: 'seti_new', customerId: 'cus_new' };
const VERIFY_RESULT = {
  verified: true, setupIntentId: 'seti_1', customerId: 'cus_1', paymentMethodId: 'pm_new',
  pledgeId: 'plg_1', eventId: EVENT_ID, buyerDid: BACKER_DID, sellerDid: CREATOR_DID,
  amount: 5000, currency: 'CAD',
};

function boundPledge(overrides: Record<string, unknown> = {}) {
  return makePledge({
    status: 'pending', stripePaymentMethodId: null,
    metadata: { sellerDid: CREATOR_DID, setupIntentContract: SETUP_INTENT_CONTRACT },
    ...overrides,
  });
}

function verifiedPayment(overrides: Record<string, unknown> = {}) {
  fetchMock.mockResolvedValue(jsonResponse(200, { ...VERIFY_RESULT, ...overrides }));
}

const pledge = (body: unknown = { eventId: EVENT_ID, amount: 2500 }) =>
  postPledge(campaignJsonRequest(PLEDGE_PATH, body, COOKIE));
const confirm = (body: unknown = { pledgeId: 'plg_1', setupIntentId: 'seti_1', paymentMethodId: 'pm_new' }) =>
  postConfirm(campaignJsonRequest(CONFIRM_PATH, body));

beforeEach(() => {
  resetCampaignMocks();
  signInAs(BACKER_DID);
  tokenMock.mockReset().mockResolvedValue('app-token');
});

describe('POST /api/campaign/pledge', () => {
  itAnswersPreflight(pledgeOptions);
  itRateLimits(() => pledge(), 10);
  itRejectsUnauthenticated(() => pledge());
  itAnswers500WhenHandlerThrows(() => pledge(), () => nextSelect(new Error('boom')), {
    error: ERR_PLEDGE_FAILED,
    logMessage: 'Campaign pledge error',
  });

  it('answers 500 for a malformed JSON body (kernel parity: no 400 for bad JSON)', async () => {
    const res = await pledge('{not json');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_PLEDGE_FAILED });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { amount: 2500 }],
    ['empty', { eventId: '', amount: 2500 }],
    ['not a string', { eventId: 42, amount: 2500 }],
  ])('answers 400 when eventId is %s', async (_label, body) => {
    const res = await pledge(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ERR_EVENT_ID_REQUIRED });
    expectCors(res);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['a numeric string', '2500'],
    ['below the $1 minimum', 99],
    ['fractional', 150.5],
    ['negative', -500],
  ])('answers 400 when amount is %s', async (_label, amount) => {
    const res = await pledge({ eventId: EVENT_ID, amount });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ERR_AMOUNT });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('accepts the minimum amount of 100 cents', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    const res = await pledge({ eventId: EVENT_ID, amount: 100 });

    expect(res.status).toBe(200);
  });

  it('answers 404 when the event does not exist', async () => {
    nextSelect([]);

    const res = await pledge();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ERR_EVENT_NOT_FOUND });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['event is not a campaign', { eventType: 'standard' }, ERR_NOT_CAMPAIGN],
    ['campaign is not published', { status: 'draft' }, 'Campaign is not available for pledging'],
    ['campaign is past its deadline', { deadline: new Date(Date.now() - 60_000) }, 'Campaign deadline has passed'],
  ])('answers 400 when the %s', async (_label, overrides, error) => {
    nextSelect([makeEvent(overrides)]);

    const res = await pledge();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'charged'])('answers 409 when the backer already has a %s pledge', async (status) => {
    nextSelect([makeEvent()]);
    nextSelect([makePledge({ status })]);

    const res = await pledge();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'You already have an active pledge for this campaign' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates a SetupIntent through the pay service and inserts a pending pledge', async () => {
    nextSelect([makeEvent({ deadline: new Date(Date.now() + 86_400_000) })]);
    nextSelect([]);
    nextInsert();
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    const res = await pledge();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ pledgeId: expect.stringMatching(/^plg_[0-9a-f]{24}$/), clientSecret: 'seti_secret' });
    expectCors(res);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${payUrl}/api/setup-intent`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer app-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 2500,
      currency: 'CAD',
      pledgeId: body.pledgeId, eventId: EVENT_ID, buyerDid: BACKER_DID, sellerDid: CREATOR_DID,
    });
    expect(valuesMock).toHaveBeenCalledWith({
      id: body.pledgeId,
      eventId: EVENT_ID,
      backerDid: BACKER_DID,
      amount: 2500,
      currency: 'CAD',
      stripeSetupIntentId: 'seti_new',
      stripeCustomerId: 'cus_new',
      status: 'pending',
      metadata: { sellerDid: CREATOR_DID, setupIntentContract: SETUP_INTENT_CONTRACT },
    });
  });

  it('never forwards a browser cookie to the pay service', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    await postPledge(campaignJsonRequest(PLEDGE_PATH, { eventId: EVENT_ID, amount: 2500 }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('Cookie');
  });

  it('re-uses and resets an abandoned pledge instead of inserting a new one', async () => {
    nextSelect([makeEvent()]);
    nextSelect([makePledge({ id: 'plg_old', status: 'pending', metadata: { note: 'kept' } })]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));
    nextUpdate([{ id: 'plg_old' }]);

    const res = await pledge({ eventId: EVENT_ID, amount: 4000 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pledgeId: 'plg_old', clientSecret: 'seti_secret' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(updatedTables()).toEqual([pledges]);
    expect(setValues()).toEqual([
      {
        amount: 4000,
        currency: 'CAD',
        stripePaymentMethodId: null,
        stripeSetupIntentId: 'seti_new',
        stripeCustomerId: 'cus_new',
        status: 'pending',
        metadata: { sellerDid: CREATOR_DID, setupIntentContract: SETUP_INTENT_CONTRACT, updatedAt: expect.any(String) },
      },
    ]);
  });

  it('fails closed when creation is refused', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(402, { error: 'card_declined' }));

    const res = await pledge();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'payment_verification_unavailable' });
    expect(mockLog.error).toHaveBeenCalledWith({ code: 'payment_verification_unavailable' }, 'Pay service SetupIntent failed');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the pay service failure has no JSON body', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(textResponse(502, 'upstream down', 'Bad Gateway'));

    const res = await pledge();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'payment_verification_unavailable' });
  });

  it('answers 500 when the pay service cannot be reached', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockRejectedValue(new Error('boom'));

    const res = await pledge();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'payment_verification_unavailable' });
  });

  it('answers 500 when the pledge cannot be stored', async () => {
    nextSelect([makeEvent()]);
    nextSelect([]);
    nextInsert(new Error('boom'));
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    const res = await pledge();

    expect(res.status).toBe(500);
    expect(mockLog.error).toHaveBeenCalledWith({ err: 'Error: boom' }, 'Campaign pledge error');
  });

  it('attributes the pledge to the acting DID', async () => {
    signInAs(CREATOR_DID);
    nextSelect([makeEvent()]);
    nextSelect([]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));

    await pledge();

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ backerDid: CREATOR_DID }));
  });
});

describe('server-verified pledge confirmation', () => {
  it('queries only the authenticated buyer and verifies canonical row values, ignoring posted bindings', async () => {
    nextSelect([boundPledge()]);
    nextUpdate([boundPledge({ status: 'confirmed', stripePaymentMethodId: 'pm_new' })]);
    verifiedPayment();
    const res = await confirm({
      pledgeId: 'plg_1', setupIntentId: 'seti_1', paymentMethodId: 'pm_new',
      buyerDid: CREATOR_DID, sellerDid: BACKER_DID, amount: 1, customerId: 'cus_forged',
    });
    expect(res.status).toBe(200);
    expect(whereParams(0)).toEqual(['plg_1', BACKER_DID]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${payUrl}/api/setup-intent/verify`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer app-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      pledgeId: 'plg_1', eventId: EVENT_ID, buyerDid: BACKER_DID, sellerDid: CREATOR_DID,
      amount: 5000, currency: 'CAD', setupIntentId: 'seti_1', customerId: 'cus_1',
    });
    expect(whereParams(1)).toEqual([
      'plg_1', EVENT_ID, BACKER_DID, 'pending', 'seti_1', 'cus_1', 5000, 'CAD',
      JSON.stringify({ sellerDid: CREATOR_DID, setupIntentContract: SETUP_INTENT_CONTRACT }),
    ]);
  });

  it('rejects another buyer before any kernel request', async () => {
    signInAs(CREATOR_DID);
    nextSelect([]);
    expect((await confirm()).status).toBe(404);
    expect(whereParams(0)).toEqual(['plg_1', CREATOR_DID]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updatedTables()).toEqual([]);
  });

  it('rejects concurrent setup replacement without overwriting a confirmed pledge', async () => {
    nextSelect([makeEvent()]);
    nextSelect([boundPledge()]);
    nextUpdate([]);
    fetchMock.mockResolvedValue(jsonResponse(200, SETUP_INTENT));
    const res = await pledge();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'pledge_changed' });
    expect(whereParams(2).slice(0, 6)).toEqual(['plg_1', BACKER_DID, 'pending', 5000, 'CAD', 'seti_1']);
  });

  it('fails closed when verification returns non-JSON', async () => {
    nextSelect([boundPledge()]);
    fetchMock.mockResolvedValue(textResponse(200, '<html>proxy</html>', 'OK'));
    expect((await confirm()).status).toBe(503);
    expect(updatedTables()).toEqual([]);
  });

  it.each([null, [], 123])('answers typed 400 for non-object JSON (%j)', async (body) => {
    expect((await confirm(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updatedTables()).toEqual([]);
  });
  it.each([
    ['not succeeded', 409, 'setup_intent_not_succeeded'],
    ['forged intent', 404, 'setup_intent_resource_not_found'],
    ['wrong pledge', 403, 'setup_intent_binding_mismatch'],
    ['wrong buyer', 403, 'setup_intent_buyer_mismatch'],
    ['wrong payment method customer', 403, 'setup_intent_customer_mismatch'],
  ])('rejects %s without changing the pledge', async (_label, status, code) => {
    nextSelect([boundPledge()]);
    fetchMock.mockResolvedValue(jsonResponse(status, { error: 'Rejected', code }));
    const res = await confirm();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'Rejected', code });
    expect(updatedTables()).toEqual([]);
  });

  it.each([
    ['verified', false], ['setupIntentId', 'seti_forged'], ['customerId', 'cus_other'],
    ['pledgeId', 'plg_other'], ['buyerDid', CREATOR_DID], ['sellerDid', BACKER_DID],
    ['eventId', 'evt_other'], ['amount', 1], ['currency', 'USD'], ['paymentMethodId', null],
  ])('fails closed when kernel success has a wrong %s', async (field, value) => {
    nextSelect([boundPledge()]);
    verifiedPayment({ [field]: value });
    expect((await confirm()).status).toBe(503);
    expect(updatedTables()).toEqual([]);
  });

  it.each([
    [404, {}], [403, { code: 'scope_required' }], [401, {}], [500, {}],
    [200, {}], [200, null], [200, []],
  ])('fails closed for an unavailable or malformed verify contract (%s)', async (status, body) => {
    nextSelect([boundPledge()]);
    fetchMock.mockImplementation(async () => jsonResponse(status, body));
    const res = await confirm();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'payment_verification_unavailable' });
    expect(updatedTables()).toEqual([]);
  });

  it('fails closed when verification cannot be reached', async () => {
    nextSelect([boundPledge()]);
    fetchMock.mockRejectedValue(new Error('offline'));
    expect((await confirm()).status).toBe(503);
    expect(updatedTables()).toEqual([]);
  });

  it('fails closed when the app cannot obtain its token', async () => {
    nextSelect([boundPledge()]);
    tokenMock.mockRejectedValue(new Error('not provisioned'));
    expect((await confirm()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updatedTables()).toEqual([]);
  });

  it('rejects a client-forged payment method even after server verification', async () => {
    nextSelect([boundPledge()]);
    verifiedPayment({ paymentMethodId: 'pm_verified' });
    const res = await confirm();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'setup_intent_payment_method_mismatch' });
    expect(updatedTables()).toEqual([]);
  });

  it('refuses legacy platform pledges rather than guessing an account', async () => {
    nextSelect([makePledge()]);
    expect((await confirm()).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updatedTables()).toEqual([]);
  });

  it.each(['cancelled', 'failed', 'refunded'])('cannot revive a %s pledge', async (status) => {
    nextSelect([boundPledge({ status })]);
    expect((await confirm()).status).toBe(409);
    expect(updatedTables()).toEqual([]);
  });

  it.each(['confirmed', 'charged'])('re-verifies a %s replay without writing or regressing status', async (status) => {
    nextSelect([boundPledge({ status, stripePaymentMethodId: 'pm_new' })]);
    verifiedPayment();
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pledge: { status } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updatedTables()).toEqual([]);
  });

  it('rejects a replay when the recorded payment method differs', async () => {
    nextSelect([boundPledge({ status: 'confirmed', stripePaymentMethodId: 'pm_old' })]);
    verifiedPayment();
    expect((await confirm()).status).toBe(409);
    expect(updatedTables()).toEqual([]);
  });

  it('handles a concurrent identical confirmation idempotently', async () => {
    nextSelect([boundPledge()]);
    nextUpdate([]);
    nextSelect([boundPledge({ status: 'confirmed', stripePaymentMethodId: 'pm_new' })]);
    verifiedPayment();
    expect((await confirm()).status).toBe(200);
    expect(updatedTables()).toHaveLength(1);
  });

  it.each([
    { status: 'cancelled' }, { status: 'pending', amount: 6000 },
    { status: 'confirmed', stripeSetupIntentId: 'seti_new' },
  ])('does not overwrite a changed pledge during verification (%j)', async (overrides) => {
    nextSelect([boundPledge()]);
    nextUpdate([]);
    nextSelect([boundPledge(overrides)]);
    verifiedPayment();
    expect((await confirm()).status).toBe(409);
  });
});

describe('POST /api/campaign/pledge/confirm', () => {
  itAnswersPreflight(confirmOptions);
  itRateLimits(() => confirm(), 20);
  itRejectsUnauthenticated(() => confirm());
  itAnswers500WhenHandlerThrows(() => confirm(), () => nextSelect(new Error('boom')), {
    error: ERR_CONFIRM_FAILED,
    logMessage: 'Campaign pledge confirm error',
  });

  it('answers typed 400 for a malformed JSON body', async () => {
    const res = await confirm('{not json');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body', code: 'invalid_request' });
  });

  it.each([
    ['pledgeId', { setupIntentId: 'seti_1', paymentMethodId: 'pm_new' }],
    ['pledgeId', { pledgeId: 7, setupIntentId: 'seti_1', paymentMethodId: 'pm_new' }],
    ['setupIntentId', { pledgeId: 'plg_1', paymentMethodId: 'pm_new' }],
    ['setupIntentId', { pledgeId: 'plg_1', setupIntentId: 7, paymentMethodId: 'pm_new' }],
    ['paymentMethodId', { pledgeId: 'plg_1', setupIntentId: 'seti_1' }],
    ['paymentMethodId', { pledgeId: 'plg_1', setupIntentId: 'seti_1', paymentMethodId: 7 }],
  ])('answers 400 when %s is missing or not a string', async (field, body) => {
    const res = await confirm(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${field} is required`, code: 'invalid_request' });
    expectCors(res);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('answers 404 when the backer has no such pledge', async () => {
    nextSelect([]);

    const res = await confirm();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Pledge not found', code: 'pledge_not_found' });
    expect(updatedTables()).toEqual([]);
  });

  it('answers 400 when the SetupIntent id does not match the pledge', async () => {
    nextSelect([makePledge({ stripeSetupIntentId: 'seti_other' })]);

    const res = await confirm();

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'SetupIntent ID mismatch', code: 'setup_intent_mismatch' });
    expect(updatedTables()).toEqual([]);
  });

  it('marks the pledge confirmed and stores the payment method', async () => {
    nextSelect([boundPledge()]);
    nextUpdate([boundPledge({ status: 'confirmed', stripePaymentMethodId: 'pm_new' })]);
    verifiedPayment();

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, pledge: { id: 'plg_1', amount: 5000, status: 'confirmed' } });
    expectCors(res);
    expect(updatedTables()).toEqual([pledges]);
    expect(setValues()).toEqual([
      {
        status: 'confirmed',
        stripePaymentMethodId: 'pm_new',
        metadata: { sellerDid: CREATOR_DID, setupIntentContract: SETUP_INTENT_CONTRACT, confirmedAt: expect.any(String) },
      },
    ]);
  });

  it('answers 500 when the pledge cannot be updated', async () => {
    nextSelect([boundPledge()]);
    nextUpdate(new Error('boom'));
    verifiedPayment();

    const res = await confirm();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: ERR_CONFIRM_FAILED });
  });
});
