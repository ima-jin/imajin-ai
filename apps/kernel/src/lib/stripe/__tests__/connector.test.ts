import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

const {
  sealV2Mock, sealV1Mock, loadMock, deleteFromVaultMock, statusMock, whereMock,
  revokeVaultGrantsMock, channelLinksRevokeMock, publishMock,
  upsertWebhookIndexMock, resolveWebhookOwnerMock, findWebhookIndexByOwnerMock, deleteWebhookIndexByOwnerMock,
} = vi.hoisted(() => ({
  sealV2Mock: vi.fn(),
  sealV1Mock: vi.fn(),
  loadMock: vi.fn(),
  deleteFromVaultMock: vi.fn(),
  statusMock: vi.fn(),
  whereMock: vi.fn(),
  revokeVaultGrantsMock: vi.fn(),
  channelLinksRevokeMock: vi.fn(),
  publishMock: vi.fn(),
  upsertWebhookIndexMock: vi.fn(),
  resolveWebhookOwnerMock: vi.fn(),
  findWebhookIndexByOwnerMock: vi.fn(),
  deleteWebhookIndexByOwnerMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({
  sealAndStore: sealV1Mock,
  sealAndStoreV2: sealV2Mock,
  loadAndUnseal: loadMock,
  deleteFromVault: deleteFromVaultMock,
  vaultFieldStatus: statusMock,
  revokeVaultDelegationGrantsForConnector: revokeVaultGrantsMock,
}));
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereMock }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: channelLinksRevokeMock }) }) }),
  },
  channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes', id: 'id' },
}));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
const receipt = vi.hoisted(() => ({ handled: true, error: undefined as string | undefined }));
vi.mock('@/src/lib/pay/stripe-relay-store', () => ({
  putRelayEntry: vi.fn(() => receipt), deleteRelayEntry: vi.fn(),
}));
// #2177: the connector registers the pay-stripe consumer before publishing; the consumer
// (and its DB-backed handlers) is irrelevant to what this suite asserts.
vi.mock('@/src/lib/pay/stripe-bus-consumer', () => ({ ensurePayStripeReactorRegistered: vi.fn() }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../webhook-index', () => ({
  upsertWebhookIndex: upsertWebhookIndexMock,
  resolveWebhookOwner: resolveWebhookOwnerMock,
  findWebhookIndexByOwner: findWebhookIndexByOwnerMock,
  deleteWebhookIndexByOwner: deleteWebhookIndexByOwnerMock,
}));

import {
  connectAndProvisionWebhook,
  disconnectAndDeprovision,
  handleVerifiedWebhookEvent,
  vaultField,
  stripeConnectorDid,
  stripeEventsScope,
  publishableKeySealed,
  sealWebhookSecret, webhookStatus,
} from '../connector';

const OWNER = 'did:imajin:scott';
const RESTRICTED_KEY = 'rk_test_fake_restricted';
const PUBLISHABLE_KEY = 'pk_test_fake_publishable';
const FULL_SECRET_KEY = 'sk_test_fake_fullsecret';
const BASE_URL = 'https://kernel.imajin.test';
const SIGNING_SECRET = 'whsec_fake_signing_secret';

type FetchMock = ReturnType<typeof vi.fn>;
const fetchMock = () => fetch as unknown as FetchMock;

/** What a key that MAY write Checkout Sessions gets for the incomplete probe session: rejected on missing params. */
const PROBE_PERMITTED = {
  ok: false,
  status: 400,
  json: async () => ({ error: { type: 'invalid_request_error', message: 'Missing required param: line_items.' } }),
};
/** What a key WITHOUT Checkout Sessions = Write gets: rejected on permission. */
const PROBE_FORBIDDEN = {
  ok: false,
  status: 403,
  json: async () => ({ error: { type: 'permission_error', message: 'This API call cannot be made with a restricted API key.' } }),
};

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function noGrant() {
  whereMock.mockResolvedValue([]);
}

function signedDelivery(payload: unknown, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`, 'utf8').digest('hex');
  return { rawBody, header: `t=${timestampSeconds},v1=${signature}` };
}

beforeEach(() => {
  receipt.handled = true; receipt.error = undefined;
  sealV2Mock.mockReset().mockResolvedValue(undefined);
  sealV1Mock.mockReset().mockResolvedValue(undefined);
  loadMock.mockReset();
  deleteFromVaultMock.mockReset().mockResolvedValue(undefined);
  statusMock.mockReset().mockResolvedValue('absent');
  whereMock.mockReset();
  revokeVaultGrantsMock.mockReset().mockResolvedValue(0);
  channelLinksRevokeMock.mockReset().mockResolvedValue([]);
  publishMock.mockReset().mockResolvedValue(undefined);
  upsertWebhookIndexMock.mockReset().mockResolvedValue(undefined);
  resolveWebhookOwnerMock.mockReset();
  findWebhookIndexByOwnerMock.mockReset().mockResolvedValue(undefined);
  deleteWebhookIndexByOwnerMock.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('identity', () => {
  it('stripeConnectorDid and stripeEventsScope are stable', () => {
    expect(stripeConnectorDid).toBe('did:imajin:stripe-connector');
    expect(stripeEventsScope).toBe('stripe:events');
  });

  it('vaultField encodes ownerDid for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`stripe-api-key:${OWNER}`);
  });
});

// ── connectAndProvisionWebhook (#1785) ────────────────────────────────────────

describe('manual webhook setup', () => {
  it.each([undefined, '', '   '])('requires a publishable key before mutations', async (publishableKey) => {
    await expect(connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL, publishableKey))
      .rejects.toMatchObject({ code: 'stripe_publishable_key_missing', field: 'publishableKey' });
    expect(fetch).not.toHaveBeenCalled();
    expect(sealV2Mock).not.toHaveBeenCalled();
  });
  it('rejects mismatched modes before mutations', async () => {
    await expect(connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL, 'pk_live_fake'))
      .rejects.toMatchObject({ code: 'stripe_key_mode_mismatch' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects full secret keys', async () => {
    await expect(connectAndProvisionWebhook(OWNER, FULL_SECRET_KEY, BASE_URL, PUBLISHABLE_KEY))
      .rejects.toMatchObject({ code: 'stripe_key_not_restricted' });
    expect(sealV2Mock).not.toHaveBeenCalled();
  });
  it('seals all three owner-entered values without creating an endpoint or secret', async () => {
    fetchMock().mockResolvedValueOnce(PROBE_PERMITTED);
    const result = await connectAndProvisionWebhook(OWNER, ` ${RESTRICTED_KEY} `, BASE_URL, ` ${PUBLISHABLE_KEY} `, ` ${SIGNING_SECRET} `);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetchMock().mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(fetchMock().mock.calls[0][1].body).toBe('mode=payment');
    expect(result).toEqual({ routingId: expect.stringContaining('stripewh_'), endpointId: '' });
    expect(sealV2Mock).toHaveBeenCalledWith(vaultField(OWNER), RESTRICTED_KEY);
    expect(sealV1Mock).toHaveBeenCalledWith(`stripe-publishable-key:${OWNER}`, PUBLISHABLE_KEY);
    expect(sealV1Mock).toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`, SIGNING_SECRET);
    expect(upsertWebhookIndexMock).toHaveBeenCalledWith(result.routingId, OWNER, '');
  });
  it('permits key-only initial setup so the owner can obtain their routing URL', async () => {
    fetchMock().mockResolvedValueOnce(PROBE_PERMITTED);
    await connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL, PUBLISHABLE_KEY);
    expect(sealV1Mock).not.toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`, expect.anything());
  });
  it('preserves existing routing and secret during key rotation', async () => {
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_existing', endpointId: 'we_existing' });
    fetchMock().mockResolvedValueOnce(PROBE_PERMITTED);
    expect(await connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL, PUBLISHABLE_KEY))
      .toEqual({ routingId: 'stripewh_existing', endpointId: 'we_existing' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(deleteFromVaultMock).not.toHaveBeenCalled();
  });
  it('rejects invalid signing secrets before any side effect', async () => {
    await expect(connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL, PUBLISHABLE_KEY, 'fake_bad'))
      .rejects.toMatchObject({ code: 'stripe_webhook_secret_invalid', field: 'webhookSecret' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects keys missing Checkout Sessions write permission before sealing', async () => {
    fetchMock().mockResolvedValueOnce(PROBE_FORBIDDEN);
    await expect(connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL, PUBLISHABLE_KEY))
      .rejects.toThrow(/stripe_key_missing_permission/);
    expect(sealV2Mock).not.toHaveBeenCalled();
  });
  it('can add a secret to an existing connector without reading or re-pasting keys', async () => {
    statusMock.mockResolvedValue('ready');
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_existing', endpointId: 'we_existing' });
    await sealWebhookSecret(OWNER, SIGNING_SECRET);
    expect(sealV1Mock).toHaveBeenCalledTimes(1);
    expect(sealV1Mock).toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`, SIGNING_SECRET);
    expect(sealV2Mock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(upsertWebhookIndexMock).not.toHaveBeenCalled();
  });
  it('refuses secret-only updates without an active key pair', async () => {
    await expect(sealWebhookSecret(OWNER, SIGNING_SECRET)).rejects.toMatchObject({ code: 'stripe_connector_missing' });
    expect(sealV1Mock).not.toHaveBeenCalled();
  });
  it('reports safe status and routing without unsealing any field', async () => {
    statusMock.mockResolvedValue('ready');
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_existing', endpointId: 'we_existing' });
    expect(await webhookStatus(OWNER, `${BASE_URL}///`)).toEqual({
      webhookSecretSealed: true, routingId: 'stripewh_existing',
      webhookUrl: `${BASE_URL}/pay/api/webhook/did/stripewh_existing`,
      webhookEvents: ['payment_intent.succeeded', 'invoice.paid', 'payout.paid'],
    });
    expect(loadMock).not.toHaveBeenCalled();
  });
});

describe('publishableKeySealed', () => {
  it.each([
    ['ready', true],
    ['absent', false],
    ['pending-grant', false],
    ['unverifiable', false],
  ])('reports %s without reading plaintext', async (status, expected) => {
    statusMock.mockResolvedValue(status);
    expect(await publishableKeySealed(OWNER)).toBe(expected);
    expect(statusMock).toHaveBeenCalledWith(`stripe-publishable-key:${OWNER}`);
    expect(loadMock).not.toHaveBeenCalled();
  });
});
// ── disconnectAndDeprovision (#1785, #1776 pattern) ───────────────────────────

describe('disconnectAndDeprovision', () => {
  it('deprovisions with the sealed key, clears routing + webhook secret, and revokes the grant', async () => {
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_1', endpointId: 'we_1' });
    loadMock.mockResolvedValueOnce(RESTRICTED_KEY).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    revokeVaultGrantsMock.mockResolvedValue(1);

    const result = await disconnectAndDeprovision(OWNER);

    expect(result).toEqual({ revoked: true, deprovisioned: true });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/webhook_endpoints/we_1');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe(`Bearer ${RESTRICTED_KEY}`);

    expect(deleteWebhookIndexByOwnerMock).toHaveBeenCalledWith(OWNER);
    expect(deleteFromVaultMock).toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`);
    expect(revokeVaultGrantsMock).toHaveBeenCalledWith('stripe', OWNER);
  });

  it('skips deprovisioning (but still cleans up) when the owner never connected', async () => {
    findWebhookIndexByOwnerMock.mockResolvedValue(undefined);
    revokeVaultGrantsMock.mockResolvedValue(0);

    const result = await disconnectAndDeprovision(OWNER);

    expect(result).toEqual({ revoked: false, deprovisioned: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(deleteWebhookIndexByOwnerMock).not.toHaveBeenCalled();
    expect(deleteFromVaultMock).toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`);
  });

  it('continues disconnecting even when the Stripe delete call fails (key already rotated)', async () => {
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_1', endpointId: 'we_1' });
    loadMock.mockResolvedValueOnce(RESTRICTED_KEY).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'Invalid API Key provided',
    });
    revokeVaultGrantsMock.mockResolvedValue(1);

    const result = await disconnectAndDeprovision(OWNER);

    expect(result).toEqual({ revoked: true, deprovisioned: false });
    expect(deleteWebhookIndexByOwnerMock).toHaveBeenCalledWith(OWNER);
  });

  it('never calls Stripe when no key is currently sealed', async () => {
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_1', endpointId: 'we_1' });
    loadMock.mockResolvedValue(undefined);
    revokeVaultGrantsMock.mockResolvedValue(0);

    const result = await disconnectAndDeprovision(OWNER);

    expect(result.deprovisioned).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── handleVerifiedWebhookEvent (#1785) ────────────────────────────────────────

describe('handleVerifiedWebhookEvent', () => {
  beforeEach(() => { statusMock.mockResolvedValue('ready'); });
  const validEvent = (id: string) => ({
    id, type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_fake', amount: 100, currency: 'usd' } },
  });

  function delivery(id: string) {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_fake' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    return signedDelivery(validEvent(id), SIGNING_SECRET);
  }

  it.each([null, [], {}, { id: 'evt_fake' }, { id: 'evt_fake', type: 'invoice.paid', data: { object: [] } },
    { id: 'evt_fake', type: 'payment_intent.succeeded', data: { object: { id: 'pi_fake', amount: -1, currency: 'usd' } } },
  ])('rejects malformed signed event shapes without publishing %#', async (payload) => {
    delivery('unused');
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);
    expect(await handleVerifiedWebhookEvent('stripewh_fake', rawBody, header)).toEqual({ status: 'malformed_payload' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('fails closed when the key is missing or revoked', async () => {
    const { rawBody, header } = delivery('evt_missing_key');
    statusMock.mockResolvedValue('absent');
    expect(await handleVerifiedWebhookEvent('stripewh_fake', rawBody, header)).toEqual({ status: 'connector_unavailable' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('uses only the indexed owner secret, not a different DID named in metadata', async () => {
    const payload = validEvent('evt_wrong_owner');
    delivery('unused');
    loadMock.mockImplementation(async (field: string) => field === `stripe-webhook-secret:${OWNER}` ? SIGNING_SECRET : 'whsec_fake_other');
    const { rawBody, header } = signedDelivery({ ...payload, account: 'did:imajin:other' }, 'whsec_fake_other');
    expect(await handleVerifiedWebhookEvent('stripewh_fake', rawBody, header)).toEqual({ status: 'invalid_signature', reason: 'signature_mismatch' });
    expect(loadMock).toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('suppresses a successful event replay within tolerance, including with a fresh signature', async () => {
    const { rawBody, header } = delivery('evt_replay_success');
    expect(await handleVerifiedWebhookEvent('stripewh_fake', rawBody, header)).toEqual({ status: 'ok', published: true });
    const fresh = signedDelivery(validEvent('evt_replay_success'), SIGNING_SECRET, Math.floor(Date.now() / 1000) + 1);
    expect(await handleVerifiedWebhookEvent('stripewh_fake', fresh.rawBody, fresh.header)).toEqual({ status: 'ok', published: false });
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent deliveries of the same owner event', async () => {
    const { rawBody, header } = delivery('evt_concurrent');
    const results = await Promise.all([
      handleVerifiedWebhookEvent('stripewh_fake', rawBody, header),
      handleVerifiedWebhookEvent('stripewh_fake', rawBody, header),
    ]);
    expect(results).toEqual([{ status: 'ok', published: true }, { status: 'ok', published: false }]);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it('does not suppress the same event id belonging to another owner', async () => {
    const { rawBody, header } = delivery('evt_cross_owner');
    await handleVerifiedWebhookEvent('stripewh_fake', rawBody, header);
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: 'did:imajin:another', endpointId: 'we_fake_other' });
    expect(await handleVerifiedWebhookEvent('stripewh_other', rawBody, header)).toEqual({ status: 'ok', published: true });
    expect(publishMock).toHaveBeenCalledTimes(2);
  });

  it.each(['publish', 'handler', 'missing-reactor'])('returns a retryable failure for %s and does not mark completed', async (failure) => {
    const { rawBody, header } = delivery(`evt_retry_${failure}`);
    if (failure === 'publish') publishMock.mockRejectedValueOnce(new Error('fake upstream failure'));
    if (failure === 'handler') receipt.error = 'fake settlement failure';
    if (failure === 'missing-reactor') receipt.handled = false;
    expect(await handleVerifiedWebhookEvent('stripewh_fake', rawBody, header)).toEqual({ status: 'processing_failed' });
    receipt.handled = true; receipt.error = undefined;
    expect(await handleVerifiedWebhookEvent('stripewh_fake', rawBody, header)).toEqual({ status: 'ok', published: true });
    expect(publishMock).toHaveBeenCalledTimes(2);
  });
  it('rejects an unknown routing id without ever loading a secret', async () => {
    resolveWebhookOwnerMock.mockResolvedValue(undefined);

    const result = await handleVerifiedWebhookEvent('stripewh_unknown', '{}', 't=1,v1=deadbeef');

    expect(result).toEqual({ status: 'unknown_routing' });
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('rejects when no signing secret is sealed for the resolved owner', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(undefined);

    const result = await handleVerifiedWebhookEvent('stripewh_1', '{}', 't=1,v1=deadbeef');

    expect(result).toEqual({ status: 'invalid_signature', reason: 'missing_secret' });
  });

  it('rejects an invalid signature (tampered or forged) — never publishes', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    // Signed with the WRONG secret: a well-formed header that will not match
    // this owner's real signing secret.
    const { rawBody, header } = signedDelivery({ id: 'evt_1', type: 'payment_intent.succeeded' }, 'wrong_secret');

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'invalid_signature', reason: 'signature_mismatch' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed signature header', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', '{}', 'not-a-real-header');

    expect(result).toEqual({ status: 'invalid_signature', reason: 'malformed_header' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('rejects a replayed delivery — genuinely signed, but the timestamp is stale', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const { rawBody, header } = signedDelivery({ id: 'evt_1', type: 'payment_intent.succeeded' }, SIGNING_SECRET, staleTimestamp);

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'invalid_signature', reason: 'timestamp_out_of_tolerance' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed JSON body even with a valid signature', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    const rawBody = 'not-json';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', SIGNING_SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, `t=${timestamp},v1=${signature}`);

    expect(result).toEqual({ status: 'malformed_payload' });
  });

  it('does not publish when the owner has no active stripe:events grant', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    noGrant();
    const { rawBody, header } = signedDelivery({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_fake', amount: 100, currency: 'usd' } } }, SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'connector_unavailable' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publishes stripe.payment_intent.succeeded attributed to the owning principal DID', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = {
      id: 'evt_pi_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', amount: 5000, currency: 'usd' } },
    };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'ok', published: true });
    expect(publishMock).toHaveBeenCalledWith('stripe.payment_intent.succeeded', {
      issuer: OWNER,
      subject: OWNER,
      scope: 'stripe',
      payload: {
        ownerDid: OWNER,
        relayId: expect.any(String),
        eventId: 'evt_pi_1',
        paymentIntentId: 'pi_123',
        amount: 5000,
        currency: 'USD',
        context_id: 'evt_pi_1',
        context_type: 'stripe',
      },
    });
  });

  it('#2754: lifts ONLY the payment_request id off the PaymentIntent metadata onto the bus payload', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = {
      id: 'evt_pi_2',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_inv',
          amount: 5650,
          currency: 'cad',
          metadata: { payment_request_id: 'pr_42', payHandle: 'ph_x', customer_note: 'private' },
        },
      },
    };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    const [, published] = publishMock.mock.calls[0];
    expect(published.payload).toMatchObject({ paymentIntentId: 'pi_inv', amount: 5650, currency: 'CAD', paymentRequestId: 'pr_42' });
    expect(JSON.stringify(published.payload)).not.toContain('private');
    expect(JSON.stringify(published.payload)).not.toContain('ph_x');
  });

  it('#2754: a PaymentIntent with no payment_request metadata publishes no paymentRequestId key at all', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = {
      id: 'evt_pi_3',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_plain', amount: 100, currency: 'usd', metadata: {} } },
    };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(publishMock.mock.calls[0][1].payload).not.toHaveProperty('paymentRequestId');
  });

  it('#2757: lifts the pay_transaction_id of a hosted checkout onto the bus payload — and nothing else from its metadata', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = {
      id: 'evt_pi_4',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_ticket',
          amount: 2500,
          currency: 'cad',
          metadata: { pay_transaction_id: 'tx_9', service: 'events', cart: '[{"private":true}]' },
        },
      },
    };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    const [, published] = publishMock.mock.calls[0];
    expect(published.payload).toMatchObject({ paymentIntentId: 'pi_ticket', amount: 2500, currency: 'CAD', payTransactionId: 'tx_9' });
    expect(published.payload).not.toHaveProperty('paymentRequestId');
    expect(JSON.stringify(published.payload)).not.toContain('private');
  });

  it('#2757: a PaymentIntent with no pay_transaction_id publishes no payTransactionId key at all', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = {
      id: 'evt_pi_5',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_plain', amount: 100, currency: 'usd', metadata: { pay_transaction_id: '' } } },
    };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(publishMock.mock.calls[0][1].payload).not.toHaveProperty('payTransactionId');
  });

  it('publishes stripe.invoice.paid attributed to the owning principal DID', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = {
      id: 'evt_in_1',
      type: 'invoice.paid',
      data: { object: { id: 'in_123', amount_paid: 3000, currency: 'cad' } },
    };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'ok', published: true });
    expect(publishMock).toHaveBeenCalledWith('stripe.invoice.paid', {
      issuer: OWNER,
      subject: OWNER,
      scope: 'stripe',
      payload: {
        ownerDid: OWNER,
        relayId: expect.any(String),
        eventId: 'evt_in_1',
        invoiceId: 'in_123',
        amountPaid: 3000,
        currency: 'CAD',
        context_id: 'evt_in_1',
        context_type: 'stripe',
      },
    });
  });

  it('publishes stripe.payout.paid attributed to the owning principal DID', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = {
      id: 'evt_po_1',
      type: 'payout.paid',
      data: { object: { id: 'po_123', amount: 1000, currency: 'usd', arrival_date: 1_700_000_000 } },
    };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'ok', published: true });
    expect(publishMock).toHaveBeenCalledWith('stripe.payout.paid', {
      issuer: OWNER,
      subject: OWNER,
      scope: 'stripe',
      payload: {
        ownerDid: OWNER,
        relayId: expect.any(String),
        eventId: 'evt_po_1',
        payoutId: 'po_123',
        amount: 1000,
        currency: 'USD',
        arrivalDate: new Date(1_700_000_000 * 1000).toISOString(),
        context_id: 'evt_po_1',
        context_type: 'stripe',
      },
    });
  });

  it('acknowledges but does not publish an event type with no bus mapping', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);
    grant(['stripe:events']);
    const payload = { id: 'evt_unmapped', type: 'charge.dispute.created', data: { object: {} } };
    const { rawBody, header } = signedDelivery(payload, SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'ok', published: false });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('never logs or echoes the signing secret in a failure result', async () => {
    resolveWebhookOwnerMock.mockResolvedValue({ ownerDid: OWNER, endpointId: 'we_1' });
    loadMock.mockResolvedValue(SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', '{}', null);

    expect(JSON.stringify(result)).not.toContain(SIGNING_SECRET);
  });
});
