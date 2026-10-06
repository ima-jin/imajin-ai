// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import PayRequestActions from '../PayRequestActions';

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
    const { container } = render(<PayRequestActions handle="ph_1" status="paid" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing once settled_manual', () => {
    const { container } = render(<PayRequestActions handle="ph_1" status="settled_manual" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('PayRequestActions — allow_on_platform rendering', () => {
  it('shows the Pay button when allow_on_platform is true', () => {
    render(<PayRequestActions handle="ph_1" status="issued" allowOnPlatform />);
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
  });

  it('shows the Pay button when allow_on_platform is absent (today\'s by-handle response)', () => {
    render(<PayRequestActions handle="ph_1" status="issued" />);
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();
  });

  it('hides the Pay button and explains why when allow_on_platform is false', () => {
    render(<PayRequestActions handle="ph_1" status="issued" allowOnPlatform={false} />);
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
    expect(screen.getByText(/isn't available for this request/)).toBeDefined();
  });

  it('always offers the sign-in path regardless of allow_on_platform', () => {
    render(<PayRequestActions handle="ph_1" status="issued" allowOnPlatform={false} />);
    expect(screen.getByText('Already connected? Sign in to pay from your account')).toBeDefined();
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

    render(<PayRequestActions handle="ph_1" status="issued" />);
    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    await waitFor(() => expect(globalThis.location.href).toBe('https://checkout.stripe.com/session_123'));
  });

  it('degrades gracefully with a friendly message when the checkout route 404s (not merged yet)', async () => {
    installFetch({ ok: false, status: 404, body: { error: 'Not found' } });
    render(<PayRequestActions handle="ph_1" status="issued" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText("Online payment isn't available for this request yet.")).toBeDefined();
  });

  it('shows a generic error on other failures without crashing', async () => {
    installFetch({ ok: false, status: 500, body: { error: 'boom' } });
    render(<PayRequestActions handle="ph_1" status="issued" />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));

    expect(await screen.findByText('Unable to start checkout. Please try again.')).toBeDefined();
  });
});

const EMT_INSTRUCTIONS = { email: 'pay@acme.example', amountMinor: 11_300, currency: 'CAD', memo: 'INV-3F9A1C07D2' };

describe('PayRequestActions — e-Transfer (#2665)', () => {
  it('shows no e-Transfer option, and keeps the "Pay now" label, when no option is passed (no receiving email set)', () => {
    render(<PayRequestActions handle="ph_1" status="issued" />);
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay now' })).toBeDefined();

    cleanup();
    render(<PayRequestActions handle="ph_1" status="issued" emt={null} />);
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
    expect(screen.queryByTestId('emt-instructions')).toBeNull();
  });

  it('offers both "Pay by card" and "Pay by e-Transfer" when the option is available — without printing the email yet', () => {
    render(<PayRequestActions handle="ph_1" status="issued" emt={{ state: 'available', instructions: null }} />);

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
    render(<PayRequestActions handle="ph/1" status="issued" emt={{ state: 'available', instructions: null }} />);

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
    render(<PayRequestActions handle="ph_1" status="emt_pending" emt={{ state: 'pending', instructions: EMT_INSTRUCTIONS }} />);

    expect(screen.getByTestId('emt-instructions')).toBeDefined();
    expect(screen.getByTestId('emt-memo').textContent).toContain('INV-3F9A1C07D2');
    expect(screen.getByRole('button', { name: 'Pay by card' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay by e-Transfer' })).toBeNull();
  });

  it('paying by card from emt_pending still starts a checkout', async () => {
    installFetch({ ok: true, body: { url: 'https://checkout.stripe.com/session_9' } });
    Object.defineProperty(globalThis, 'location', { value: { ...globalThis.location, href: 'https://pay.test/r/ph_1' }, writable: true });

    render(<PayRequestActions handle="ph_1" status="emt_pending" emt={{ state: 'pending', instructions: EMT_INSTRUCTIONS }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pay by card' }));

    await waitFor(() => expect(globalThis.location.href).toBe('https://checkout.stripe.com/session_9'));
  });

  it.each([
    ['a non-OK response', { ok: false, status: 400, body: { error: 'nope' } }],
    ['a malformed body', { ok: true, body: { success: true } }],
  ])('shows an inline error — and the button stays — on %s', async (_label, response) => {
    installFetch(response);
    render(<PayRequestActions handle="ph_1" status="issued" emt={{ state: 'available', instructions: null }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));

    expect(await screen.findByText('Unable to start the e-Transfer payment. Please try again.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pay by e-Transfer' })).toBeDefined();
    expect(screen.queryByTestId('emt-instructions')).toBeNull();
  });

  it('shows an inline error when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<PayRequestActions handle="ph_1" status="issued" emt={{ state: 'available', instructions: null }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pay by e-Transfer' }));

    expect(await screen.findByText('Unable to start the e-Transfer payment. Please try again.')).toBeDefined();
  });

  it.each(['paid', 'settled_manual', 'void'])('renders nothing for a %s request even if an option were passed', (status) => {
    const { container } = render(<PayRequestActions handle="ph_1" status={status} emt={{ state: 'available', instructions: null }} />);
    expect(container.innerHTML).toBe('');
  });
});

