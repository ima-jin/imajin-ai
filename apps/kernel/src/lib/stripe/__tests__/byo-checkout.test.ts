import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loadSealedCredentialsMock } = vi.hoisted(() => ({ loadSealedCredentialsMock: vi.fn() }));

vi.mock('../connector-core', () => ({
  stripe: { loadSealedCredentials: loadSealedCredentialsMock },
}));

import {
  ByoCheckoutError,
  assertCheckoutSessionWriteAllowed,
  createByoCheckoutSession,
  retrieveByoCheckoutSession,
} from '../byo-checkout';

const OWNER = 'did:imajin:imajin-inc';
const KEY = 'rk_live_issuerkey';

const INPUT = {
  items: [
    { name: 'Platform build', description: 'Phase 1', amount: 100_000, quantity: 2 },
    { name: 'GST/HST (CA-ON)', amount: 26_000, quantity: 1 },
  ],
  currency: 'CAD',
  successUrl: 'https://pay.test/r/ph_1',
  cancelUrl: 'https://pay.test/r/ph_1',
  customerEmail: 'payer@example.com',
  metadata: { payment_request_id: 'pr_1', payHandle: 'ph_1' },
};

function stripeResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

function sentForm(callIndex = 0): URLSearchParams {
  return new URLSearchParams(fetchMock().mock.calls[callIndex][1].body as string);
}

beforeEach(() => {
  loadSealedCredentialsMock.mockReset().mockResolvedValue({ apiKey: KEY });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createByoCheckoutSession', () => {
  it('creates the session on the ISSUER\'s account with their own restricted key — nothing Connect about it', async () => {
    fetchMock().mockResolvedValue(
      stripeResponse(200, { id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1', expires_at: 1_800_000_000 }),
    );

    const session = await createByoCheckoutSession(OWNER, INPUT);

    expect(session).toEqual({
      id: 'cs_live_1',
      url: 'https://checkout.stripe.com/c/pay/cs_live_1',
      expiresAt: new Date(1_800_000_000 * 1000),
    });
    expect(loadSealedCredentialsMock).toHaveBeenCalledWith(OWNER);

    const [url, init] = fetchMock().mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const form = sentForm();
    // No destination charge, no application fee, no Stripe-Account header: the money lands in the issuer's account.
    expect([...form.keys()].join(' ')).not.toMatch(/transfer_data|application_fee|on_behalf_of/);
    expect(init.headers).not.toHaveProperty('Stripe-Account');
    expect(form.get('mode')).toBe('payment');
    expect(form.get('payment_method_types[0]')).toBe('card');
  });

  it('sends every line item (merchandise and tax) with lower-cased currency and integer minor units', async () => {
    fetchMock().mockResolvedValue(stripeResponse(200, { id: 'cs_1', url: 'https://x', expires_at: 1 }));

    await createByoCheckoutSession(OWNER, INPUT);

    const form = sentForm();
    expect(form.get('line_items[0][price_data][product_data][name]')).toBe('Platform build');
    expect(form.get('line_items[0][price_data][product_data][description]')).toBe('Phase 1');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('100000');
    expect(form.get('line_items[0][quantity]')).toBe('2');
    expect(form.get('line_items[0][price_data][currency]')).toBe('cad');
    expect(form.get('line_items[1][price_data][product_data][name]')).toBe('GST/HST (CA-ON)');
    expect(form.get('line_items[1][price_data][unit_amount]')).toBe('26000');
    expect(form.has('line_items[1][price_data][product_data][description]')).toBe(false);
    expect(form.has('line_items[2][quantity]')).toBe(false);
  });

  it('writes the metadata onto BOTH the session and its PaymentIntent, so the owner\'s own payment_intent.succeeded names the request', async () => {
    fetchMock().mockResolvedValue(stripeResponse(200, { id: 'cs_1', url: 'https://x', expires_at: 1 }));

    await createByoCheckoutSession(OWNER, INPUT);

    const form = sentForm();
    expect(form.get('metadata[payment_request_id]')).toBe('pr_1');
    expect(form.get('metadata[payHandle]')).toBe('ph_1');
    expect(form.get('payment_intent_data[metadata][payment_request_id]')).toBe('pr_1');
    expect(form.get('payment_intent_data[metadata][payHandle]')).toBe('ph_1');
  });

  it('passes the return URLs and payer email, and expires the session in about a day', async () => {
    fetchMock().mockResolvedValue(stripeResponse(200, { id: 'cs_1', url: 'https://x', expires_at: 1 }));
    const before = Math.floor(Date.now() / 1000);

    await createByoCheckoutSession(OWNER, INPUT);

    const form = sentForm();
    expect(form.get('success_url')).toBe('https://pay.test/r/ph_1');
    expect(form.get('cancel_url')).toBe('https://pay.test/r/ph_1');
    expect(form.get('customer_email')).toBe('payer@example.com');
    const expiresAt = Number(form.get('expires_at'));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 3600);
    expect(expiresAt).toBeLessThanOrEqual(before + 24 * 3600 + 5);
  });

  it('omits customer_email when none is given', async () => {
    fetchMock().mockResolvedValue(stripeResponse(200, { id: 'cs_1', url: 'https://x', expires_at: 1 }));

    await createByoCheckoutSession(OWNER, { ...INPUT, customerEmail: undefined });

    expect(sentForm().has('customer_email')).toBe(false);
  });

  it.each([
    ['no sealed key', undefined],
    ['a credential with no apiKey', {}],
  ])('fails with no_key — and never calls Stripe — on %s', async (_label, credentials) => {
    loadSealedCredentialsMock.mockResolvedValue(credentials);

    await expect(createByoCheckoutSession(OWNER, INPUT)).rejects.toMatchObject({ name: 'ByoCheckoutError', code: 'no_key' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a 401 (revoked or rotated key)', 401, { error: { type: 'authentication_error', message: 'Invalid API Key' } }, 'key_rejected'],
    ['a 403 (missing permission)', 403, { error: { type: 'permission_error', message: 'cannot be made with a restricted key' } }, 'key_rejected'],
    ['a permission_error on a 400', 400, { error: { type: 'permission_error', message: 'x' } }, 'key_rejected'],
    ['a 429', 429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'unavailable'],
    ['a 503', 503, {}, 'unavailable'],
    ['a 400 about the request itself', 400, { error: { type: 'invalid_request_error', message: 'Invalid currency: xxx' } }, 'request_rejected'],
  ])('classifies %s as %s', async (_label, status, body, code) => {
    fetchMock().mockResolvedValue(stripeResponse(status, body));

    const error = await createByoCheckoutSession(OWNER, INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ByoCheckoutError);
    expect((error as ByoCheckoutError).code).toBe(code);
    expect((error as ByoCheckoutError).stripeStatus).toBe(status);
  });

  it('never puts the restricted key in an error message', async () => {
    fetchMock().mockResolvedValue(stripeResponse(401, { error: { type: 'authentication_error', message: 'Invalid API Key provided' } }));

    const error = (await createByoCheckoutSession(OWNER, INPUT).catch((e: unknown) => e)) as Error;

    expect(error.message).not.toContain(KEY);
  });

  it('classifies an unreachable Stripe as unavailable', async () => {
    fetchMock().mockRejectedValue(new Error('ECONNRESET'));

    await expect(createByoCheckoutSession(OWNER, INPUT)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('classifies a non-JSON error page by status alone', async () => {
    fetchMock().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });

    await expect(createByoCheckoutSession(OWNER, INPUT)).rejects.toMatchObject({ code: 'unavailable', stripeStatus: 502 });
  });

  it('treats a 200 without id/url/expires_at as unavailable rather than returning a half session', async () => {
    fetchMock().mockResolvedValue(stripeResponse(200, { id: 'cs_1' }));

    await expect(createByoCheckoutSession(OWNER, INPUT)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('retrieveByoCheckoutSession', () => {
  it('reads the session back on the issuer\'s account with their key', async () => {
    fetchMock().mockResolvedValue(
      stripeResponse(200, { id: 'cs_old', url: 'https://checkout.stripe.com/cs_old', status: 'open', expires_at: 1_800_000_000 }),
    );

    const session = await retrieveByoCheckoutSession(OWNER, 'cs_old');

    expect(session).toEqual({
      id: 'cs_old',
      url: 'https://checkout.stripe.com/cs_old',
      status: 'open',
      expiresAt: new Date(1_800_000_000 * 1000),
    });
    const [url, init] = fetchMock().mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_old');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init).not.toHaveProperty('body');
  });

  it('url-encodes the session id', async () => {
    fetchMock().mockResolvedValue(stripeResponse(200, { id: 'cs/odd' }));

    await retrieveByoCheckoutSession(OWNER, 'cs/odd');

    expect(fetchMock().mock.calls[0][0]).toBe('https://api.stripe.com/v1/checkout/sessions/cs%2Fodd');
  });

  it('reports nulls for fields Stripe did not send', async () => {
    fetchMock().mockResolvedValue(stripeResponse(200, { id: 'cs_old' }));

    expect(await retrieveByoCheckoutSession(OWNER, 'cs_old')).toEqual({ id: 'cs_old', url: null, status: null, expiresAt: null });
  });

  it('fails with the classified error when Stripe refuses, and with no_key when nothing is sealed', async () => {
    fetchMock().mockResolvedValue(stripeResponse(404, { error: { type: 'invalid_request_error', message: 'No such session' } }));
    await expect(retrieveByoCheckoutSession(OWNER, 'cs_gone')).rejects.toMatchObject({ code: 'request_rejected' });

    loadSealedCredentialsMock.mockResolvedValue(undefined);
    await expect(retrieveByoCheckoutSession(OWNER, 'cs_gone')).rejects.toMatchObject({ code: 'no_key' });
  });
});

describe('assertCheckoutSessionWriteAllowed', () => {
  it('passes a key Stripe rejects only for the incomplete session (400 invalid_request_error)', async () => {
    fetchMock().mockResolvedValue(stripeResponse(400, { error: { type: 'invalid_request_error', message: 'Missing required param' } }));

    await expect(assertCheckoutSessionWriteAllowed(KEY)).resolves.toBeUndefined();
    expect(sentForm().toString()).toBe('mode=payment');
  });

  it.each([
    ['a 403', stripeResponse(403, { error: { type: 'invalid_request_error', message: 'x' } })],
    ['a permission_error', stripeResponse(400, { error: { type: 'permission_error', message: 'x' } })],
  ])('throws stripe_key_missing_permission on %s', async (_label, response) => {
    fetchMock().mockResolvedValue(response);

    await expect(assertCheckoutSessionWriteAllowed(KEY)).rejects.toThrow(/^stripe_key_missing_permission: .*Checkout Sessions = Write/);
  });

  it.each([
    ['a 401 (the webhook provisioning step reports a bad key itself)', stripeResponse(401, { error: { type: 'authentication_error', message: 'x' } })],
    ['a 500', stripeResponse(500, {})],
  ])('does not fail the connect on %s', async (_label, response) => {
    fetchMock().mockResolvedValue(response);

    await expect(assertCheckoutSessionWriteAllowed(KEY)).resolves.toBeUndefined();
  });

  it('does not fail the connect when Stripe is unreachable', async () => {
    fetchMock().mockRejectedValue(new Error('offline'));

    await expect(assertCheckoutSessionWriteAllowed(KEY)).resolves.toBeUndefined();
  });
});
