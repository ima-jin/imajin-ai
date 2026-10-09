// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

const getInvoiceMock = vi.fn();

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

/** The first real invoice: Imajin Inc → a customer, CA$2,000 + 13% HST = CA$2,260. */
const ISSUED_VIEW = {
  kind: 'invoice',
  lineItems: [
    { name: 'Platform build', description: 'Phase 1 delivery', amount: 100_000, quantity: 2 },
  ],
  totalAmount: 226_000,
  subtotalAmount: 200_000,
  taxTotalAmount: 26_000,
  taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 26_000, registrationNumber: '123456789RT0001' }],
  currency: 'CAD',
  issuerDisplayName: 'Imajin Inc',
  issuerAddress: '1 Example St\nToronto, ON M5V 1A1',
  status: 'issued',
  invoiceNumber: 'INV-3F9A1C07D2',
  issuedAt: '2026-10-01T15:30:00.000Z',
  dueAt: '2026-10-06T00:00:00.000Z',
  paidAt: null,
  settlement: null,
  paidBy: null,
  card: true,
  emt: null,
};

const PAID_VIEW = {
  ...ISSUED_VIEW,
  status: 'paid',
  paidAt: '2026-10-09T18:45:00.000Z',
  settlement: { method: 'stripe', reference: 'pi_3Abc123' },
};

async function renderPage(view: unknown) {
  getInvoiceMock.mockResolvedValue(view);
  render(await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) }));
}

function text(testId: string): string {
  return screen.getByTestId(testId).textContent ?? '';
}

beforeAll(() => {
  // West of UTC is where #2651's due-date bug showed; the invoice must not shift.
  vi.stubEnv('TZ', 'America/Toronto');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('printable invoice — contents (#2661)', () => {
  it('prints the document number, issue date, due date as the entered calendar date, currency and Issued status', async () => {
    await renderPage(ISSUED_VIEW);

    expect(text('invoice-number')).toContain('INV-3F9A1C07D2');
    expect(text('invoice-issued')).toContain('2026-10-01');
    // Stored as UTC midnight; must read 2026-10-06, not 2026-10-05, in America/Toronto.
    expect(text('invoice-due')).toContain('2026-10-06');
    expect(text('invoice-currency')).toContain('CAD');
    expect(text('invoice-status')).toContain('Issued');
  });

  it('omits the due-date row when no due date was entered', async () => {
    await renderPage({ ...ISSUED_VIEW, dueAt: null });
    expect(screen.queryByTestId('invoice-due')).toBeNull();
  });

  it('prints the issuer business name and address', async () => {
    await renderPage(ISSUED_VIEW);

    expect(screen.getByRole('heading', { name: 'Imajin Inc' })).toBeDefined();
    expect(text('issuer-address')).toContain('1 Example St');
    expect(text('issuer-address')).toContain('Toronto, ON M5V 1A1');
  });

  it('omits the address when the profile has none', async () => {
    await renderPage({ ...ISSUED_VIEW, issuerAddress: null });
    expect(screen.queryByTestId('issuer-address')).toBeNull();
  });

  it('prints line items (with description), subtotal, the tax line with rate AND registration number, and the total', async () => {
    await renderPage(ISSUED_VIEW);

    expect(screen.getByText(/Platform build/)).toBeDefined();
    expect(screen.getByText('Phase 1 delivery')).toBeDefined();

    const breakdown = text('tax-breakdown');
    expect(breakdown).toContain('Subtotal');
    expect(breakdown).toContain('2,000.00');
    expect(breakdown).toContain('GST/HST (CA-ON) · 13%');
    expect(breakdown).toContain('Registration no. 123456789RT0001');
    expect(breakdown).toContain('260.00');

    expect(screen.getByText('Total due')).toBeDefined();
    expect(screen.getByText(/2,260\.00/)).toBeDefined();
  });

  it('exposes no DID or recipient data — only the typed-in "Billed to" can name the recipient', async () => {
    await renderPage({ ...ISSUED_VIEW, issuerDid: 'did:imajin:issuer', recipientDid: 'did:imajin:customer' });
    expect(document.body.textContent).not.toContain('did:imajin');
    expect(screen.queryByTestId('billed-to-print')).toBeNull();
  });
});

describe('printable invoice — receipt mode once paid (#2661)', () => {
  it('shows a paid stamp, "Paid on <date>", the payment date and the settlement ref, titled as a receipt', async () => {
    await renderPage(PAID_VIEW);

    expect(screen.getByTestId('paid-stamp').textContent).toBe('Paid');
    expect(text('invoice-status')).toContain('Paid on 2026-10-09');
    expect(text('receipt-paid-date')).toContain('2026-10-09');
    expect(text('receipt-settlement-ref')).toContain('stripe · pi_3Abc123');
    expect(screen.getByText('Receipt from')).toBeDefined();
    expect(screen.getByText('Total paid')).toBeDefined();
    expect(screen.queryByText('Total due')).toBeNull();
  });

  it('a manually settled request is a receipt too, and shows the method when the rail has no reference', async () => {
    await renderPage({
      ...PAID_VIEW,
      status: 'settled_manual',
      settlement: { method: 'manual', reference: null },
    });

    expect(screen.getByTestId('paid-stamp')).toBeDefined();
    expect(text('receipt-settlement-ref')).toContain('manual');
    expect(text('receipt-settlement-ref')).not.toContain('·');
  });

  it('#2665: an e-Transfer settlement renders the same receipt — paid stamp, date, total paid — naming the rail and the memo', async () => {
    await renderPage({
      ...PAID_VIEW,
      settlement: { method: 'emt', reference: 'INV-3F9A1C07D2' },
    });

    expect(screen.getByTestId('paid-stamp').textContent).toBe('Paid');
    expect(text('invoice-status')).toContain('Paid on 2026-10-09');
    expect(text('receipt-paid-date')).toContain('2026-10-09');
    expect(text('receipt-settlement-ref')).toContain('e-Transfer · INV-3F9A1C07D2');
    expect(screen.getByText('Receipt from')).toBeDefined();
    expect(screen.getByText('Total paid')).toBeDefined();
    // Settled: no pay actions, e-Transfer or card, on the receipt.
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
    expect(screen.queryByTestId('emt-instructions')).toBeNull();
  });

  it('#2656: the receipt names the paying DID — Artifact when Eric paid as Artifact', async () => {
    await renderPage({ ...PAID_VIEW, paidBy: { did: 'did:imajin:artifact', displayName: 'Artifact' } });

    expect(text('receipt-paid-by')).toContain('Artifact');
    expect(text('receipt-paid-by-did')).toContain('did:imajin:artifact');
  });

  it('#2656: an open invoice names nobody as payer', async () => {
    await renderPage(ISSUED_VIEW);
    expect(screen.queryByTestId('receipt-paid-by')).toBeNull();
    expect(screen.queryByTestId('receipt-paid-by-did')).toBeNull();
  });

  it('degrades to a plain "Paid" status when no payment date was recorded', async () => {
    await renderPage({ ...PAID_VIEW, paidAt: null, settlement: null });

    expect(text('invoice-status')).toContain('Paid');
    expect(text('invoice-status')).not.toContain('Paid on');
    expect(screen.queryByTestId('receipt-paid-date')).toBeNull();
    expect(screen.queryByTestId('receipt-settlement-ref')).toBeNull();
  });

  it('an unpaid invoice has no stamp and no receipt block', async () => {
    await renderPage(ISSUED_VIEW);

    expect(screen.queryByTestId('paid-stamp')).toBeNull();
    expect(screen.queryByTestId('receipt-details')).toBeNull();
    expect(screen.getByText('Invoice from')).toBeDefined();
  });
});

describe('printable invoice — print-only styling hooks (#2661)', () => {
  it('wraps the document in the .invoice-page / .invoice-sheet hooks the print stylesheet targets', async () => {
    await renderPage(ISSUED_VIEW);

    const sheet = document.querySelector('.invoice-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet?.closest('.invoice-page')).not.toBeNull();
    expect(sheet?.textContent).toContain('Imajin Inc');
  });

  it('marks the print button, Pay now / sign-in actions and the status note as screen-only', async () => {
    await renderPage({ ...ISSUED_VIEW });
    const hidden = Array.from(document.querySelectorAll("[data-print='hide']"));

    const printButton = screen.getByRole('button', { name: 'Print / Download PDF' });
    const payNow = screen.getByRole('button', { name: 'Pay now' });
    const signIn = screen.getByRole('link', { name: /Sign in to pay/ });
    for (const element of [printButton, payNow, signIn]) {
      expect(hidden.some((container) => container.contains(element))).toBe(true);
    }
  });

  it('hides the paid status note in print, and renders no Pay now once paid', async () => {
    await renderPage(PAID_VIEW);

    const note = screen.getByText('This has already been paid.');
    expect(note.closest("[data-print='hide']")).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
  });

  it('keeps document rows together across pages via data-invoice-row', async () => {
    await renderPage(ISSUED_VIEW);
    const rows = document.querySelectorAll('.invoice-sheet [data-invoice-row]');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(within(screen.getByTestId('invoice-meta')).getByText('Invoice no.')).toBeDefined();
    expect(screen.getByTestId('invoice-meta').hasAttribute('data-invoice-row')).toBe(true);
  });

  it('prints the registration-number line in the muted style the print sheet darkens', async () => {
    await renderPage(ISSUED_VIEW);
    const line = screen.getByText('Registration no. 123456789RT0001');
    expect(line.classList.contains('invoice-muted')).toBe(true);
  });
});

describe('printable invoice — Print / Download PDF action (#2661)', () => {
  it('opens the browser print dialog (Save as PDF) when clicked', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    await renderPage(ISSUED_VIEW);

    fireEvent.click(screen.getByRole('button', { name: 'Print / Download PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Save as PDF/)).toBeDefined();
  });

  it('is offered on a paid receipt as well', async () => {
    await renderPage(PAID_VIEW);
    expect(screen.getByRole('button', { name: 'Print / Download PDF' })).toBeDefined();
  });
});

describe('printable invoice — optional "Billed to" (#2661)', () => {
  it('prints what the payer typed, and keeps the input itself screen-only', async () => {
    await renderPage(ISSUED_VIEW);
    const input = screen.getByLabelText(/Billed to/);
    expect(input.closest("[data-print='hide']")).not.toBeNull();

    fireEvent.change(input, { target: { value: 'Blake Studios Ltd.' } });

    const printed = screen.getByTestId('billed-to-print');
    expect(printed.textContent).toContain('Blake Studios Ltd.');
    expect(printed.className).toContain('print:block');
    expect(printed.className).toContain('hidden');
  });

  it('prints nothing for a blank or whitespace-only entry', async () => {
    await renderPage(ISSUED_VIEW);
    fireEvent.change(screen.getByLabelText(/Billed to/), { target: { value: '   ' } });
    expect(screen.queryByTestId('billed-to-print')).toBeNull();
  });
});

describe('printable invoice — access gate (#2661)', () => {
  it('404s for an unknown or void handle, exactly like the pay page', async () => {
    getInvoiceMock.mockResolvedValue(null);
    await expect(PayByHandlePage({ params: Promise.resolve({ handle: 'nope' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(getInvoiceMock).toHaveBeenCalledWith('nope');
  });
});
