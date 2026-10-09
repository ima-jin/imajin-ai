// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import PayRequestActions, { checkoutErrorMessage } from '../PayRequestActions';

vi.mock('next/navigation', () => ({
  usePathname: () => '/pay/r/ph_1',
}));

function installFetch(response: { ok: boolean; status?: number; body: unknown }) {
  const spy = vi.fn(async () => ({ ok: response.ok, status: response.status ?? (response.ok ? 200 : 500), json: async () => response.body }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PayRequestActions — status gating', () => {
  it('renders nothing once paid', () => {
    const { container } = render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="paid" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing once settled_manual', () => {
    const { container } = render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="settled_manual" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PayRequestActions — only the rails that work (#2754)', () => {
  const EMT_AVAILABLE = { state: 'available', instructions: null } as const;

  it('card only: shows "Pay now" and no e-Transfer', () => {
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" emt={null} />);
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.queryByTestId('no-online-payment')).toBeNull();
  });

  it('e-Transfer only: NO card button at all — just e-Transfer', () => {
    render(<PayRequestActions issuerName="Acme" card={false} handle="ph_1" status="issued" emt={EMT_AVAILABLE} />);
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Pay now|Pay by card/ })).toBeNull();
    expect(screen.queryByTestId('no-online-payment')).toBeNull();
  });

  it('e-Transfer only: the instructions do not suggest a card option that does not exist', () => {
    render(
      <PayRequestActions
        issuerName="Acme"
        card={false}
        handle="ph_1"
        status="emt_pending"
        emt={{ state: 'pending', instructions: { email: 'pay@acme.example', amountMinor: 100, currency: 'CAD', memo: 'INV-1' } }}
      />,
    );
    expect(screen.getByTestId('emt-instructions').textContent).not.toMatch(/pay by card/i);
    expect(screen.queryByTestId('emt-pay-another-way')).toBeNull();
  });

  it.each(['issued', 'emt_pending'])('neither rail (%s): says so plainly, names the issuer, and renders no button and no sign-in nudge', (status) => {
    render(<PayRequestActions issuerName="Imajin Inc" card={false} handle="ph_1" status={status} emt={null} />);

    expect(screen.getByTestId('no-online-payment').textContent).toBe("This invoice can't be paid online yet. Contact Imajin Inc.");
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/Sign in to pay/)).toBeNull();
  });

  it('card + e-Transfer: both are offered', () => {
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" emt={EMT_AVAILABLE} />);
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
  });

  it('keeps the sign-in path whenever a rail is offered', () => {
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);
    expect(screen.getByText('Already connected? Sign in to pay from your account')).toBeDefined();
  });
});

describe('checkoutErrorMessage (#2754) — a card failure is never a generic "try again"', () => {
  it.each([
    ['SELLER_NOT_CONNECTED', 400, /Acme hasn't set up card payments yet\. Contact Acme/],
    ['CARD_RAIL_KEY_MISSING', 502, /Acme's Stripe connection isn't active/],
    ['CARD_RAIL_KEY_REJECTED', 502, /Stripe rejected Acme's connection.*Contact Acme/],
    ['CARD_RAIL_REQUEST_REJECTED', 502, /amount or currency may not be supported.*Contact Acme/],
    ['CARD_RAIL_UNAVAILABLE', 502, /Stripe isn't responding.*haven't been charged/],
  ])('%s maps to its own message', (code, status, expected) => {
    expect(checkoutErrorMessage(status, code, 'Acme')).toMatch(expected);
  });

  it.each([
    [401, /Sign in to pay by card/],
    [403, /can't pay this request as the selected identity/],
    [404, /isn't available for this request yet/],
    [409, /can no longer be paid by card/],
  ])('status %i without a code has a specific message', (status, expected) => {
    expect(checkoutErrorMessage(status, undefined, 'Acme')).toMatch(expected);
  });

  it('an unrecognised failure still names the status and the issuer, and never says "try again"', () => {
    const message = checkoutErrorMessage(500, 'SOMETHING_NEW', 'Acme');
    expect(message).toContain('error 500');
    expect(message).toMatch(/contact Acme/i);
    expect(message).not.toMatch(/try again/i);
    expect(message).not.toContain('Unable to start checkout');
  });
});

describe('PayRequestActions — checkout (#2215 may not be merged yet)', () => {
  it('redirects to the checkout url on success', async () => {
    installFetch({ ok: true, body: { url: 'https://checkout.stripe.com/session_123' } });
    const originalHref = globalThis.location.href;
    Object.defineProperty(globalThis, 'location', {
      value: { ...globalThis.location, href: originalHref },
      writable: true,
    });

    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);
    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    await waitFor(() => expect(globalThis.location.href).toBe('https://checkout.stripe.com/session_123'));
  });

  it('degrades gracefully with a friendly message when the checkout route 404s (not merged yet)', async () => {
    installFetch({ ok: false, status: 404, body: { error: 'Not found' } });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText("Online payment isn't available for this request yet.")).toBeDefined();
  });

  it('shows a specific message on an unexpected failure, without crashing', async () => {
    installFetch({ ok: false, status: 500, body: { error: 'boom' } });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText(/problem on our side \(error 500\).*contact Acme/)).toBeDefined();
    expect(screen.queryByText(/Unable to start checkout/)).toBeNull();
  });

  it('turns the server\'s SELLER_NOT_CONNECTED 400 into the issuer-specific message', async () => {
    installFetch({ ok: false, status: 400, body: { error: "This issuer hasn't set up card payments", code: 'SELLER_NOT_CONNECTED' } });
    render(<PayRequestActions issuerName="Imajin Inc" card handle="ph_1" status="issued" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText("Imajin Inc hasn't set up card payments yet. Contact Imajin Inc to pay another way.")).toBeDefined();
  });

  it('turns a CARD_RAIL_KEY_REJECTED 502 into a message about the issuer\'s Stripe connection', async () => {
    installFetch({ ok: false, status: 502, body: { error: 'x', code: 'CARD_RAIL_KEY_REJECTED' } });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText(/Stripe rejected Acme's connection/)).toBeDefined();
  });

  it('says it could not reach the server (and that nothing was charged) when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/payer-dids')) return { ok: false, status: 401, json: async () => ({}) };
      throw new Error('offline');
    }));
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText(/Couldn't reach the server.*haven't been charged/)).toBeDefined();
  });
});

const EMT_INSTRUCTIONS = { email: 'pay@acme.example', amountMinor: 11_300, currency: 'CAD', memo: 'INV-3F9A1C07D2' };

describe('PayRequestActions — e-Transfer (#2665)', () => {
  it('shows no e-Transfer option, and keeps the "Pay now" label, when no option is passed (no receiving email set)', () => {
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();

    cleanup();
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" emt={null} />);
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.queryByTestId('emt-instructions')).toBeNull();
  });

  it('offers both "Pay by card" and "Pay by e-Transfer" when the option is available — without printing the email yet', () => {
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" emt={{ state: 'available', instructions: null }} />);

    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
    expect(screen.queryByTestId('emt-instructions')).toBeNull();
    expect(screen.queryByText(/pay@acme\.example/)).toBeNull();
  });

  it('choosing e-Transfer POSTs to the by-handle route, then shows the email, the exact amount and the memo', async () => {
    const spy = installFetch({
      ok: true,
      body: { success: true, instructions: { email: 'pay@acme.example', amount: 113, amountMinor: 11_300, currency: 'CAD', memo: 'INV-3F9A1C07D2' } },
    });
    render(<PayRequestActions issuerName="Acme" card handle="ph/1" status="issued" emt={{ state: 'available', instructions: null }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));

    expect(await screen.findByTestId('emt-instructions')).toBeDefined();
    expect(spy).toHaveBeenCalledWith('/pay/api/payment-requests/by-handle/ph%2F1/emt', { method: 'POST' });
    expect(screen.getByTestId('emt-email').textContent).toContain('pay@acme.example');
    expect(screen.getByTestId('emt-amount').textContent).toContain('113.00');
    expect(screen.getByTestId('emt-memo').textContent).toContain('INV-3F9A1C07D2');
    // The e-Transfer button gives way to the instructions; card stays available.
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
  });

  it('an emt_pending request shows the instructions straight away to someone returning to the link, and still offers card', () => {
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={{ state: 'pending', instructions: EMT_INSTRUCTIONS }} />);

    expect(screen.getByTestId('emt-instructions')).toBeDefined();
    expect(screen.getByTestId('emt-memo').textContent).toContain('INV-3F9A1C07D2');
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
  });

  it('paying by card from emt_pending still starts a checkout', async () => {
    installFetch({ ok: true, body: { url: 'https://checkout.stripe.com/session_9' } });
    Object.defineProperty(globalThis, 'location', { value: { ...globalThis.location, href: 'https://pay.test/r/ph_1' }, writable: true });

    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={{ state: 'pending', instructions: EMT_INSTRUCTIONS }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pay by card' }));

    await waitFor(() => expect(globalThis.location.href).toBe('https://checkout.stripe.com/session_9'));
  });

  it.each([
    ['a 404', { ok: false, status: 404, body: { error: 'nope' } }, /e-Transfer isn't available for this request\. Contact Acme/],
    ['a 409', { ok: false, status: 409, body: { error: 'nope' } }, /can no longer be paid.*contact Acme/],
    ['a 400', { ok: false, status: 400, body: { error: 'nope' } }, /problem on our side \(error 400\)/],
    ['a malformed body', { ok: true, body: { success: true } }, /problem on our side \(error 502\)/],
  ])('shows a specific inline error — and the button stays — on %s', async (_label, response, expected) => {
    installFetch(response);
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" emt={{ state: 'available', instructions: null }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));

    expect(await screen.findByText(expected)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
    expect(screen.queryByTestId('emt-instructions')).toBeNull();
  });

  it('shows an inline error when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" emt={{ state: 'available', instructions: null }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));

    expect(await screen.findByText(/Couldn't reach the server/)).toBeDefined();
  });

  it.each(['paid', 'settled_manual', 'void'])('renders nothing for a %s request even if an option were passed', (status) => {
    const { container } = render(<PayRequestActions issuerName="Acme" card handle="ph_1" status={status} emt={{ state: 'available', instructions: null }} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PayRequestActions — "Pay another way" (#2758)', () => {
  const PENDING = { state: 'pending', instructions: EMT_INSTRUCTIONS } as const;
  const EMT_URL = '/pay/api/payment-requests/by-handle/ph_1/emt';

  it('offers the control under the instructions while another way (card) exists', () => {
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={PENDING} />);
    expect(screen.getByRole('button', { name: 'Pay another way' })).toBeDefined();
  });

  it('DELETEs the e-Transfer choice, then leaves the instructions and offers the e-Transfer button again', async () => {
    const spy = installFetch({ ok: true, body: { success: true, reverted: true, status: 'issued' } });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={PENDING} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay another way' }));

    await waitFor(() => expect(screen.queryByTestId('emt-instructions')).toBeNull());
    expect(spy).toHaveBeenCalledWith(EMT_URL, { method: 'DELETE' });
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
  });

  it('after leaving, choosing e-Transfer again shows the same memo', async () => {
    const routed = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/payer-dids')) return { ok: false, status: 401, json: async () => ({}) };
      if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({ success: true }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, instructions: { email: 'pay@acme.example', amountMinor: 11_300, currency: 'CAD', memo: 'INV-3F9A1C07D2' } }),
      };
    });
    vi.stubGlobal('fetch', routed);
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={PENDING} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay another way' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pay by e-Transfer' }));

    expect((await screen.findByTestId('emt-memo')).textContent).toContain('INV-3F9A1C07D2');
  });

  it('a 409 (the issuer already confirmed a deposit) keeps the instructions and says why', async () => {
    installFetch({ ok: false, status: 409, body: { error: 'confirmed' } });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={PENDING} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay another way' }));

    expect(await screen.findByText(/Acme has already confirmed a payment.*can't switch/)).toBeDefined();
    expect(screen.getByTestId('emt-instructions')).toBeDefined();
  });

  it.each([
    [404, /can't be found any more/],
    [500, /problem on our side \(error 500\).*details are still valid/],
  ])('a %i keeps the instructions and gives a specific message', async (status, expected) => {
    installFetch({ ok: false, status, body: {} });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={PENDING} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay another way' }));

    expect(await screen.findByText(expected)).toBeDefined();
    expect(screen.getByTestId('emt-instructions')).toBeDefined();
  });

  it('a dropped connection keeps the instructions and says nothing changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/payer-dids')) return { ok: false, status: 401, json: async () => ({}) };
      throw new Error('offline');
    }));
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="emt_pending" emt={PENDING} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay another way' }));

    expect(await screen.findByText(/Couldn't reach the server/)).toBeDefined();
    expect(screen.getByTestId('emt-instructions')).toBeDefined();
  });
});

const PAYER_DIDS_URL = '/pay/api/payment-requests/ph_1/payer-dids';
const PICKER_BODY = {
  dids: [
    { did: 'did:imajin:eric', kind: 'personal', displayName: 'Eric' },
    { did: 'did:imajin:artifact', kind: 'organization', displayName: 'Artifact' },
  ],
  defaultDid: 'did:imajin:eric',
};

/** Routes by URL: the picker feed, the checkout POST and the e-Transfer POST each get their own response. */
function installRoutedFetch(routes: { payerDids: { ok: boolean; status?: number; body?: unknown }; checkout?: unknown; emt?: unknown }) {
  const spy = vi.fn(async (url: string) => {
    if (url.endsWith('/payer-dids')) {
      const r = routes.payerDids;
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 401), json: async () => r.body ?? {} };
    }
    if (url.endsWith('/emt')) return { ok: true, status: 200, json: async () => routes.emt };
    return { ok: true, status: 200, json: async () => routes.checkout };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function bodyOfCall(spy: ReturnType<typeof vi.fn>, urlSuffix: string): Record<string, unknown> {
  const call = spy.mock.calls.find(([url]) => String(url).endsWith(urlSuffix))!;
  return JSON.parse((call[1] as { body: string }).body);
}

describe('PayRequestActions — "Pay as" picker (#2656)', () => {
  it('an anonymous payer (payer-dids 401s) sees no picker and the checkout body carries no paidByDid', async () => {
    const spy = installRoutedFetch({ payerDids: { ok: false, status: 401 }, checkout: { url: 'https://checkout.stripe.com/s1' } });
    Object.defineProperty(globalThis, 'location', { value: { ...globalThis.location, href: 'https://pay.test/r/ph_1' }, writable: true });

    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(PAYER_DIDS_URL));
    expect(screen.queryByTestId('pay-as')).toBeNull();
    expect(screen.queryByTestId('pay-as-single')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));
    await waitFor(() => expect(globalThis.location.href).toBe('https://checkout.stripe.com/s1'));
    expect(bodyOfCall(spy, '/checkout')).not.toHaveProperty('paidByDid');
  });

  it('a signed-in payer sees "Pay as" with their own DID and their businesses, defaulting to the server-chosen one', async () => {
    installRoutedFetch({ payerDids: { ok: true, body: PICKER_BODY } });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    const select = (await screen.findByLabelText('Pay as')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Eric (you)', 'Artifact']);
    expect(select.value).toBe('did:imajin:eric');
  });

  it('picking Artifact posts paidByDid to checkout', async () => {
    const spy = installRoutedFetch({ payerDids: { ok: true, body: PICKER_BODY }, checkout: { url: 'https://checkout.stripe.com/s2' } });
    Object.defineProperty(globalThis, 'location', { value: { ...globalThis.location, href: 'https://pay.test/r/ph_1' }, writable: true });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    fireEvent.change(await screen.findByLabelText('Pay as'), { target: { value: 'did:imajin:artifact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    await waitFor(() => expect(globalThis.location.href).toBe('https://checkout.stripe.com/s2'));
    expect(bodyOfCall(spy, '/checkout')).toMatchObject({ paidByDid: 'did:imajin:artifact' });
  });

  it('paying as the default personal DID still sends it explicitly', async () => {
    const spy = installRoutedFetch({ payerDids: { ok: true, body: PICKER_BODY }, checkout: { url: 'https://checkout.stripe.com/s3' } });
    Object.defineProperty(globalThis, 'location', { value: { ...globalThis.location, href: 'https://pay.test/r/ph_1' }, writable: true });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    await screen.findByLabelText('Pay as');
    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    await waitFor(() => expect(globalThis.location.href).toBe('https://checkout.stripe.com/s3'));
    expect(bodyOfCall(spy, '/checkout')).toMatchObject({ paidByDid: 'did:imajin:eric' });
  });

  it('picking Artifact posts paidByDid to the e-Transfer route as well', async () => {
    const spy = installRoutedFetch({
      payerDids: { ok: true, body: PICKER_BODY },
      emt: { success: true, instructions: { email: 'pay@acme.example', amountMinor: 11_300, currency: 'CAD', memo: 'INV-1' } },
    });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" emt={{ state: 'available', instructions: null }} />);

    fireEvent.change(await screen.findByLabelText('Pay as'), { target: { value: 'did:imajin:artifact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));

    expect(await screen.findByTestId('emt-instructions')).toBeDefined();
    expect(bodyOfCall(spy, '/emt')).toEqual({ paidByDid: 'did:imajin:artifact' });
  });

  it('a payer with only themselves sees who they are paying as, not a select', async () => {
    installRoutedFetch({
      payerDids: { ok: true, body: { dids: [PICKER_BODY.dids[0]], defaultDid: 'did:imajin:eric' } },
    });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    expect((await screen.findByTestId('pay-as-single')).textContent).toContain('Eric');
    expect(screen.queryByLabelText('Pay as')).toBeNull();
  });

  it('a server 403 on checkout (an identity the payer cannot act for) surfaces a specific message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/payer-dids')
          ? { ok: true, status: 200, json: async () => PICKER_BODY }
          : { ok: false, status: 403, json: async () => ({ error: 'nope' }) },
      ),
    );
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    await screen.findByLabelText('Pay as');
    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText("You can't pay this request as the selected identity.")).toBeDefined();
  });

  it('an unexpected 200 body (not a picker feed) leaves the page exactly as it was', async () => {
    installRoutedFetch({ payerDids: { ok: true, body: { url: 'https://example.test' } } });
    render(<PayRequestActions issuerName="Acme" card handle="ph_1" status="issued" />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined());
    expect(screen.queryByTestId('pay-as')).toBeNull();
    expect(screen.queryByTestId('pay-as-single')).toBeNull();
  });
});
