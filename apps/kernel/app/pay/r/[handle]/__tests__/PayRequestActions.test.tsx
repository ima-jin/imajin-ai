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
