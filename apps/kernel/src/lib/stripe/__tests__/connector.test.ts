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
  STRIPE_CONNECTOR_DID,
  STRIPE_EVENTS_SCOPE,
} from '../connector';

const OWNER = 'did:imajin:scott';
const RESTRICTED_KEY = 'rk_test_51ABCrestricted';
const FULL_SECRET_KEY = 'sk_test_51ABCfullsecret';
const BASE_URL = 'https://kernel.imajin.test';
const SIGNING_SECRET = 'whsec_new_secret';

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
  it('STRIPE_CONNECTOR_DID and STRIPE_EVENTS_SCOPE are stable', () => {
    expect(STRIPE_CONNECTOR_DID).toBe('did:imajin:stripe-connector');
    expect(STRIPE_EVENTS_SCOPE).toBe('stripe:events');
  });

  it('vaultField encodes ownerDid for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`stripe-api-key:${OWNER}`);
  });
});

// ── connectAndProvisionWebhook (#1785) ────────────────────────────────────────

describe('connectAndProvisionWebhook', () => {
  it('rejects a non-restricted key and never calls Stripe or seals anything', async () => {
    await expect(connectAndProvisionWebhook(OWNER, FULL_SECRET_KEY, BASE_URL))
      .rejects.toThrow(/stripe_key_not_restricted/);

    expect(fetch).not.toHaveBeenCalled();
    expect(sealV2Mock).not.toHaveBeenCalled();
    expect(sealV1Mock).not.toHaveBeenCalled();
    expect(upsertWebhookIndexMock).not.toHaveBeenCalled();
  });

  it('provisions the webhook with the restricted key, then seals the key and signing secret and indexes the routing id', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'we_new', secret: SIGNING_SECRET }),
    });

    const result = await connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL);

    expect(result).toEqual({ routingId: expect.stringContaining('stripewh_'), endpointId: 'we_new' });

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/webhook_endpoints');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${RESTRICTED_KEY}`);
    const body = init.body as string;
    expect(body).toContain(`url=${encodeURIComponent(`${BASE_URL}/stripe/api/webhook/${result.routingId}`)}`);
    expect(body).toContain('enabled_events%5B%5D=payment_intent.succeeded');
    expect(body).toContain('enabled_events%5B%5D=invoice.paid');
    expect(body).toContain('enabled_events%5B%5D=payout.paid');

    expect(sealV2Mock).toHaveBeenCalledWith(vaultField(OWNER), RESTRICTED_KEY);
    expect(sealV1Mock).toHaveBeenCalledWith(`stripe-webhook-secret:${OWNER}`, SIGNING_SECRET);
    expect(upsertWebhookIndexMock).toHaveBeenCalledWith(result.routingId, OWNER, 'we_new');
  });

  it('trims whitespace pasted around the key', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'we_new', secret: SIGNING_SECRET }),
    });

    await connectAndProvisionWebhook(OWNER, `  ${RESTRICTED_KEY}  `, BASE_URL);

    expect(sealV2Mock).toHaveBeenCalledWith(vaultField(OWNER), RESTRICTED_KEY);
  });

  it('never seals anything when Stripe rejects the endpoint creation', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid API Key provided',
    });

    await expect(connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL))
      .rejects.toThrow(/stripe_webhook_provision_failed/);

    expect(sealV2Mock).not.toHaveBeenCalled();
    expect(sealV1Mock).not.toHaveBeenCalled();
    expect(upsertWebhookIndexMock).not.toHaveBeenCalled();
  });

  it('rejects when Stripe responds ok without id/secret', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({}) });

    await expect(connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL))
      .rejects.toThrow(/stripe_webhook_provision_failed/);
    expect(sealV2Mock).not.toHaveBeenCalled();
  });

  it('best-effort deprovisions a prior endpoint (with the OLD key) before provisioning the new one', async () => {
    const OLD_KEY = 'rk_test_oldkey';
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_old', endpointId: 'we_old' });
    loadMock
      .mockResolvedValueOnce(OLD_KEY) // apiKey read by loadSealedCredentials
      .mockResolvedValueOnce(undefined) // baseUrl (unused field, still probed)
      .mockResolvedValueOnce(undefined); // modelId (unused field, still probed)

    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true }) // DELETE old endpoint
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'we_new', secret: SIGNING_SECRET }) }); // POST new

    await connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL);

    const [deleteUrl, deleteInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(deleteUrl).toBe('https://api.stripe.com/v1/webhook_endpoints/we_old');
    expect(deleteInit.method).toBe('DELETE');
    expect(deleteInit.headers.Authorization).toBe(`Bearer ${OLD_KEY}`);

    const [, postInit] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(postInit.headers.Authorization).toBe(`Bearer ${RESTRICTED_KEY}`);
  });

  it('proceeds with the reconnect even when best-effort deprovision of the old endpoint fails', async () => {
    findWebhookIndexByOwnerMock.mockResolvedValue({ routingId: 'stripewh_old', endpointId: 'we_old' });
    loadMock.mockResolvedValueOnce('rk_test_oldkey').mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'No such webhook endpoint' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'we_new', secret: SIGNING_SECRET }) });

    const result = await connectAndProvisionWebhook(OWNER, RESTRICTED_KEY, BASE_URL);
    expect(result.endpointId).toBe('we_new');
    expect(sealV2Mock).toHaveBeenCalledWith(vaultField(OWNER), RESTRICTED_KEY);
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
    const { rawBody, header } = signedDelivery({ id: 'evt_1', type: 'payment_intent.succeeded' }, SIGNING_SECRET);

    const result = await handleVerifiedWebhookEvent('stripewh_1', rawBody, header);

    expect(result).toEqual({ status: 'ok', published: false });
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
        eventId: 'evt_pi_1',
        paymentIntentId: 'pi_123',
        amount: 5000,
        currency: 'USD',
        context_id: 'evt_pi_1',
        context_type: 'stripe',
      },
    });
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
