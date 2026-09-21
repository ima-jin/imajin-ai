// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const getPaymentRequestByHandleMock = vi.fn();

vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  getPaymentRequestByHandle: getPaymentRequestByHandleMock,
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
    getPaymentRequestByHandleMock.mockResolvedValue({
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
      totalAmount: 1999,
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'issued',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    expect(getPaymentRequestByHandleMock).toHaveBeenCalledWith('ph_1');
  });

  it('renders the issuer name, line items, and total — no PII beyond the by-handle view', async () => {
    getPaymentRequestByHandleMock.mockResolvedValue({
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 1999, quantity: 2 }],
      totalAmount: 3998,
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
    getPaymentRequestByHandleMock.mockResolvedValue({
      kind: 'invoice',
      lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
      totalAmount: 1999,
      currency: 'CAD',
      issuerDisplayName: 'Acme Co',
      status: 'paid',
    });

    const jsx = await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_1' }) });
    render(jsx);

    expect(screen.getByText('This has already been paid.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
  });

  it('404s for an unknown or void handle, same as the underlying by-handle route', async () => {
    getPaymentRequestByHandleMock.mockResolvedValue(null);

    await expect(PayByHandlePage({ params: Promise.resolve({ handle: 'does-not-exist' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
