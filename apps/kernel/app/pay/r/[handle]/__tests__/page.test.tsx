// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const getInvoiceMock = vi.fn();

/** Printable-view fields (#2661) the older pay-page cases don't care about. */
const INVOICE_FIELDS = {
  invoiceNumber: 'INV-3F9A1C07D2',
  issuedAt: '2026-10-01T15:30:00.000Z',
  dueAt: null,
  issuerAddress: null,
  paidAt: null,
  settlement: null,
  // #2754: resolved server-side — a working card rail (the older cases below all have one).
  card: true,
};

vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  getPaymentRequestInvoiceByHandle: getInvoiceMock,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  usePathname: () => '/pay/r/ph_1',
}));

const { default: PayByHandlePage } = await import('../page');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GET /pay/r/:handle — route wiring', () => {
  it('looks up the payment_request by the handle from the URL params', async () => {
    getInvoiceMock.mockResolvedValue({
      ...INVOICE_FIELDS,
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
      totalAmount: 1999,
      subtotalAmount: 1999,
      taxTotalAmount: 0,
      taxes: [],
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    expect(getInvoiceMock).toHaveBeenCalledWith('ph_1');
  });

  it('renders the issuer name, line items, and total — no PII beyond the by-handle view', async () => {
    getInvoiceMock.mockResolvedValue({
      ...INVOICE_FIELDS,
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 1999, quantity: 2 }],
      totalAmount: 3998,
      subtotalAmount: 3998,
      taxTotalAmount: 0,
      taxes: [],
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    expect(screen.getByText('Acme Co')).toBeDefined();
    expect(screen.getByText(/Consulting/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
  });

  it('shows a status note and no Pay button once already paid', async () => {
    getInvoiceMock.mockResolvedValue({
      ...INVOICE_FIELDS,
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
      totalAmount: 1999,
      subtotalAmount: 1999,
      taxTotalAmount: 0,
      taxes: [],
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'paid',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    expect(screen.getByText('This has already been paid.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
  });

  it('without tax: renders exactly as before — no subtotal row, no tax lines, just the total', async () => {
    getInvoiceMock.mockResolvedValue({
      ...INVOICE_FIELDS,
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
      totalAmount: 1999,
      subtotalAmount: 1999,
      taxTotalAmount: 0,
      taxes: [],
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    expect(screen.queryByTestId('tax-breakdown')).toBeNull();
    expect(screen.queryByText('Subtotal')).toBeNull();
    expect(screen.queryByText(/Registration no\./)).toBeNull();
    expect(screen.getByText('Total due')).toBeDefined();
    // Line item price and total both read $19.99 (formatted via packages/money).
    expect(screen.getAllByText(/19\.99/)).toHaveLength(2);
  });

  it('with tax: shows subtotal → each tax line (kind, jurisdiction, rate, registration number) → total', async () => {
    getInvoiceMock.mockResolvedValue({
      ...INVOICE_FIELDS,
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 5000, quantity: 2 }],
      totalAmount: 11_300,
      subtotalAmount: 10_000,
      taxTotalAmount: 1300,
      taxes: [
        { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 1300, registrationNumber: '123456789RT0001' },
      ],
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    const breakdown = screen.getByTestId('tax-breakdown');
    expect(breakdown.textContent).toContain('Subtotal');
    expect(breakdown.textContent).toContain('100.00');
    expect(breakdown.textContent).toContain('GST/HST (CA-ON) · 13%');
    expect(breakdown.textContent).toContain('Registration no. 123456789RT0001');
    expect(breakdown.textContent).toContain('13.00');
    expect(screen.getByText('Total due')).toBeDefined();
    expect(screen.getByText(/113\.00/)).toBeDefined();

    // Order: subtotal, then tax, then total.
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Subtotal')).toBeLessThan(text.indexOf('GST/HST'));
    expect(text.indexOf('GST/HST')).toBeLessThan(text.indexOf('Total due'));
  });

  it('with multiple taxes (GST + PST): one line per registration, each with its own number and rate', async () => {
    getInvoiceMock.mockResolvedValue({
      ...INVOICE_FIELDS,
      kind: 'invoice',
      lineItems: [{ name: 'Build', amount: 20_002, quantity: 1 }],
      totalAmount: 22_402,
      subtotalAmount: 20_002,
      taxTotalAmount: 2400,
      taxes: [
        { jurisdiction: 'CA-BC', kind: 'GST/HST', rateBps: 500, amount: 1000, registrationNumber: '987654321RT0001' },
        { jurisdiction: 'CA-BC', kind: 'PST', rateBps: 700, amount: 1400, registrationNumber: '12345678' },
      ],
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    const breakdown = screen.getByTestId('tax-breakdown').textContent ?? '';
    expect(breakdown).toContain('GST/HST (CA-BC) · 5%');
    expect(breakdown).toContain('PST (CA-BC) · 7%');
    expect(breakdown).toContain('Registration no. 987654321RT0001');
    expect(breakdown).toContain('Registration no. 12345678');
    expect(screen.getByText(/224\.02/)).toBeDefined();
  });

  it('still offers Pay now for a taxed request (the server derives the Stripe tax line item)', async () => {
    getInvoiceMock.mockResolvedValue({
      ...INVOICE_FIELDS,
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 5000, quantity: 1 }],
      totalAmount: 5650,
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 650, registrationNumber: '123456789RT0001' }],
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });
    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
  });

  it('404s for an unknown or void handle, same as the underlying by-handle route', async () => {
    getInvoiceMock.mockResolvedValue(null);

    await expect(PayByHandlePage({ params: Promise.resolve({ handle: 'does-not-exist' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('GET /pay/r/:handle — e-Transfer option with and without the receiving email (#2665)', () => {
  const OPEN_VIEW = {
    ...INVOICE_FIELDS,
    kind: 'invoice',
    lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
    totalAmount: 1999,
    subtotalAmount: 1999,
    taxTotalAmount: 0,
    taxes: [],
    currency: 'CAD',
    issuerDisplayName: 'Acme Co',
    status: 'issued',
  };

  async function renderView(view: Record<string, unknown>) {
    getInvoiceMock.mockResolvedValue(view);
    render(await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) }));
  }

  it('WITHOUT the email set (emt: null): card only — no e-Transfer button, and the original "Pay now" label', async () => {
    await renderView({ ...OPEN_VIEW, emt: null });

    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.queryByTestId('emt-instructions')).toBeNull();
  });

  it('a view with no emt field at all (older shape) renders exactly the card-only page', async () => {
    await renderView(OPEN_VIEW);

    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
  });

  it('WITH the email set: shows "Pay by card" and "Pay by e-Transfer" side by side, and never prints the email up front', async () => {
    await renderView({ ...OPEN_VIEW, emt: { state: 'available', instructions: null } });

    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
    expect(document.body.textContent).not.toContain('@');
  });

  it('an emt_pending request is still a live request: the instructions (email, exact amount, memo) are shown, with no "no longer active" note', async () => {
    await renderView({
      ...OPEN_VIEW,
      status: 'emt_pending',
      emt: { state: 'pending', instructions: { email: 'pay@acme.example', amountMinor: 1999, currency: 'CAD', memo: 'INV-3F9A1C07D2' } },
    });

    expect(screen.getByTestId('emt-email').textContent).toContain('pay@acme.example');
    expect(screen.getByTestId('emt-amount').textContent).toContain('19.99');
    expect(screen.getByTestId('emt-memo').textContent).toContain('INV-3F9A1C07D2');
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
    expect(screen.queryByText(/no longer active/)).toBeNull();
    expect(screen.queryByText(/already been paid/)).toBeNull();
  });
});


describe('GET /pay/r/:handle — only the rails that work (#2754)', () => {
  const VIEW = {
    ...INVOICE_FIELDS,
    kind: 'invoice',
    lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
    totalAmount: 1999,
    subtotalAmount: 1999,
    taxTotalAmount: 0,
    taxes: [],
    currency: 'CAD',
    issuerDisplayName: 'Imajin Inc',
    status: 'issued',
  };
  const EMT = { state: 'available', instructions: null };

  async function renderView(view: Record<string, unknown>) {
    getInvoiceMock.mockResolvedValue(view);
    render(await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) }));
  }

  it('neither a card rail nor an e-Transfer email: says so plainly, with no Pay button anywhere', async () => {
    await renderView({ ...VIEW, card: false, emt: null });

    expect(screen.getByTestId('no-online-payment').textContent).toBe("This invoice can't be paid online yet. Contact Imajin Inc.");
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });

  it('only e-Transfer: the card button is hidden, e-Transfer is the only way offered', async () => {
    await renderView({ ...VIEW, card: false, emt: EMT });

    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Pay now|Pay by card/ })).toBeNull();
    expect(screen.queryByTestId('no-online-payment')).toBeNull();
  });

  it('only a card rail: card is offered, e-Transfer is not', async () => {
    await renderView({ ...VIEW, card: true, emt: null });

    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
  });

  it('a paid invoice shows no pay actions and no "can\'t be paid online" message', async () => {
    await renderView({ ...VIEW, status: 'paid', card: false, emt: null });

    expect(screen.queryByTestId('no-online-payment')).toBeNull();
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });
});
