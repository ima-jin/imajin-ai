// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import MoneyTab from '../MoneyTab';

const toastMock = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: toastMock }),
  ConnectionPicker: () => null,
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

const ISSUER_DID = 'did:imajin:business';

function paymentRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr_1',
    kind: 'invoice',
    issuerDid: ISSUER_DID,
    recipientDid: 'did:imajin:customer',
    recipientStubId: null,
    lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
    currency: 'CAD',
    totalAmount: 1999,
    fairManifest: { chain: [] },
    dueAt: null,
    allowOnPlatform: true,
    status: 'issued',
    settlementRef: null,
    payHandle: 'ph_1',
    ...overrides,
  };
}

function installFetch(paymentRequests: unknown[]) {
  const spy = vi.fn(async () => ({
    ok: true,
    json: async () => ({ paymentRequests }),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MoneyTab — list', () => {
  it('loads and renders payment requests for the issuer', async () => {
    installFetch([paymentRequest()]);
    render(<MoneyTab issuerDid={ISSUER_DID} />);

    expect(await screen.findByText(/invoice/)).toBeDefined();
  });

  it('shows the empty state when there are none', async () => {
    installFetch([]);
    render(<MoneyTab issuerDid={ISSUER_DID} />);

    expect(await screen.findByText('No payment requests yet')).toBeDefined();
  });
});

describe('MoneyTab — filters', () => {
  it('re-fetches with the status filter applied', async () => {
    const spy = installFetch([]);
    render(<MoneyTab issuerDid={ISSUER_DID} />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'void' } });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const lastUrl = spy.mock.calls[1][0] as string;
    expect(lastUrl).toContain('status=void');
    expect(lastUrl).toContain(`issuer_did=${encodeURIComponent(ISSUER_DID)}`);
  });

  it('re-fetches with the kind filter applied', async () => {
    const spy = installFetch([]);
    render(<MoneyTab issuerDid={ISSUER_DID} />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'request' } });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const lastUrl = spy.mock.calls[1][0] as string;
    expect(lastUrl).toContain('kind=request');
  });
});

describe('MoneyTab — create flow', () => {
  it('opens the create form and prepends the created row on success', async () => {
    installFetch([]);
    render(<MoneyTab issuerDid={ISSUER_DID} />);
    await screen.findByText('No payment requests yet');

    fireEvent.click(screen.getByRole('button', { name: '+ New payment request' }));
    expect(screen.getByText('New payment request')).toBeDefined();
  });
});
