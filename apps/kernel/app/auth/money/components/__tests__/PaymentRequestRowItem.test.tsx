// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import PaymentRequestRowItem from '../PaymentRequestRowItem';
import type { PaymentRequestRow } from '../../lib/types';

const toastMock = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

vi.mock('@imajin/ui', () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: (service: string) => `https://${service}.example`,
}));

function row(overrides: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
  return {
    id: 'pr_1',
    kind: 'invoice',
    issuerDid: 'did:imajin:business',
    payeeAccount: 'did:imajin:business',
    recipientDid: 'did:imajin:customer',
    recipientStubId: null,
    lineItems: [{ name: 'Consulting', amount: 1999, quantity: 1 }],
    currency: 'CAD',
    totalAmount: 1999,
    fairManifest: { version: '0.4.0', chain: [{ role: 'seller', share: 0.9 }], total: { amount: 1999, currency: 'CAD' } },
    dueAt: null,
    allowOnPlatform: true,
    status: 'issued',
    settlementRef: null,
    contentHash: 'hash',
    payHandle: 'ph_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function installFetch(response: { ok: boolean; body: unknown }) {
  const spy = vi.fn(async () => ({ ok: response.ok, json: async () => response.body }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function expandRow() {
  fireEvent.click(screen.getByRole('button', { name: /invoice/ }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PaymentRequestRowItem — due date (#2651)', () => {
  beforeAll(() => {
    vi.stubEnv('TZ', 'America/Toronto');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  // Date.UTC avoids depending on the process locale for the expected text.
  const expectedDue = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { timeZone: 'UTC' });

  it('renders the entered date for a row stored as UTC midnight (the day-early bug)', () => {
    const stored = '2026-10-06T00:00:00.000Z';
    // Guard: the old local-zone rendering really is a day early in this zone, so the test can fail.
    expect(new Date(stored).toLocaleDateString()).not.toBe(expectedDue(2026, 10, 6));

    render(<PaymentRequestRowItem row={row({ dueAt: stored })} onChanged={vi.fn()} />);
    expect(screen.getByText(`· due ${expectedDue(2026, 10, 6)}`)).toBeDefined();
  });

  it('renders the entered date at a year boundary', () => {
    render(<PaymentRequestRowItem row={row({ dueAt: '2027-01-01T00:00:00.000Z' })} onChanged={vi.fn()} />);
    expect(screen.getByText(`· due ${expectedDue(2027, 1, 1)}`)).toBeDefined();
  });

  it('renders no due text when the request has no due date', () => {
    render(<PaymentRequestRowItem row={row({ dueAt: null })} onChanged={vi.fn()} />);
    expect(screen.queryByText(/· due /)).toBeNull();
  });
});

describe('PaymentRequestRowItem — actions visibility', () => {
  it('shows Mark settled / Void only when issued', () => {
    render(<PaymentRequestRowItem row={row({ status: 'issued' })} onChanged={vi.fn()} />);
    expandRow();

    expect(screen.getByRole('button', { name: 'Mark settled (off-platform)' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Void' })).toBeDefined();
  });

  it('hides Mark settled / Void once settled_manual', () => {
    render(<PaymentRequestRowItem row={row({ status: 'settled_manual' })} onChanged={vi.fn()} />);
    expandRow();

    expect(screen.queryByRole('button', { name: 'Mark settled (off-platform)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });

  it('hides Mark settled / Void once void', () => {
    render(<PaymentRequestRowItem row={row({ status: 'void' })} onChanged={vi.fn()} />);
    expandRow();

    expect(screen.queryByRole('button', { name: 'Mark settled (off-platform)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });
});

describe('PaymentRequestRowItem — mark settled', () => {
  it('reveals a note field, then confirms with a manual settle POST', async () => {
    const spy = installFetch({ ok: true, body: { ...row(), status: 'settled_manual' } });
    const onChanged = vi.fn();
    render(<PaymentRequestRowItem row={row()} onChanged={onChanged} />);
    expandRow();

    fireEvent.click(screen.getByRole('button', { name: 'Mark settled (off-platform)' }));
    fireEvent.change(screen.getByLabelText('Settlement note (optional)'), { target: { value: 'Paid via e-transfer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm settled' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      '/pay/api/payment-requests/pr_1/settle',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ method: 'manual', note: 'Paid via e-transfer' });
  });

  it('cancels back to the action buttons without calling the API', () => {
    const spy = installFetch({ ok: true, body: {} });
    render(<PaymentRequestRowItem row={row()} onChanged={vi.fn()} />);
    expandRow();

    fireEvent.click(screen.getByRole('button', { name: 'Mark settled (off-platform)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Mark settled (off-platform)' })).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces a server error via toast', async () => {
    installFetch({ ok: false, body: { error: "cannot settle a payment_request in status 'void'" } });
    render(<PaymentRequestRowItem row={row()} onChanged={vi.fn()} />);
    expandRow();

    fireEvent.click(screen.getByRole('button', { name: 'Mark settled (off-platform)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm settled' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("cannot settle a payment_request in status 'void'"));
  });
});

describe('PaymentRequestRowItem — void', () => {
  it('requires window.confirm before calling the void route', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const spy = installFetch({ ok: true, body: { ...row(), status: 'void' } });
    const onChanged = vi.fn();
    render(<PaymentRequestRowItem row={row()} onChanged={onChanged} />);
    expandRow();

    fireEvent.click(screen.getByRole('button', { name: 'Void' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith('/pay/api/payment-requests/pr_1/void', expect.objectContaining({ method: 'POST' }));
  });

  it('does nothing when the confirm dialog is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const spy = installFetch({ ok: true, body: {} });
    render(<PaymentRequestRowItem row={row()} onChanged={vi.fn()} />);
    expandRow();

    fireEvent.click(screen.getByRole('button', { name: 'Void' }));

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('PaymentRequestRowItem — settlement reference', () => {
  it('shows the method and the note when a settlement note was recorded', () => {
    render(
      <PaymentRequestRowItem
        row={row({ status: 'settled_manual', settlementRef: { method: 'etransfer', note: 'ref 42' } as PaymentRequestRow['settlementRef'] })}
        onChanged={vi.fn()}
      />,
    );
    expandRow();

    expect(screen.getByText('etransfer — ref 42')).toBeDefined();
  });

  it('shows just the method when no note was recorded', () => {
    render(
      <PaymentRequestRowItem
        row={row({ status: 'settled_manual', settlementRef: { method: 'cash' } as PaymentRequestRow['settlementRef'] })}
        onChanged={vi.fn()}
      />,
    );
    expandRow();

    expect(screen.getByText('cash')).toBeDefined();
  });

  it('shows a dash placeholder when there is no settlement reference', () => {
    render(<PaymentRequestRowItem row={row({ settlementRef: null })} onChanged={vi.fn()} />);
    expandRow();

    const label = screen.getByText('Settlement ref');
    expect(label.nextElementSibling?.textContent).toBe('—');
  });
});

describe('PaymentRequestRowItem — Print / Download PDF (#2661)', () => {
  it('links to the handle-gated invoice with ?print=1 so the print dialog opens on load', () => {
    render(<PaymentRequestRowItem row={row()} onChanged={vi.fn()} />);
    expandRow();

    const link = screen.getByRole('link', { name: 'Print / Download PDF' });
    expect(link.getAttribute('href')).toBe('https://pay.example/r/ph_1?print=1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('is offered on a paid row (the receipt)', () => {
    render(<PaymentRequestRowItem row={row({ status: 'paid' })} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /invoice/ }));
    expect(screen.getByRole('link', { name: 'Print / Download PDF' })).toBeDefined();
  });

  it('is not offered on a void row — its pay link 404s', () => {
    render(<PaymentRequestRowItem row={row({ status: 'void' })} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /invoice/ }));
    expect(screen.queryByRole('link', { name: 'Print / Download PDF' })).toBeNull();
  });
});
