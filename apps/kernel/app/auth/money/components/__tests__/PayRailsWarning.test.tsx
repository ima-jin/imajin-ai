// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import PayRailsWarning from '../PayRailsWarning';

const ISSUER = 'did:imajin:imajin-inc';
const RAILS_URL = `/pay/api/payment-requests/rails?issuer_did=${encodeURIComponent(ISSUER)}`;

function installRails(response: { ok: boolean; body: unknown } | 'throw') {
  const spy = vi.fn(async () => {
    if (response === 'throw') throw new Error('offline');
    return { ok: response.ok, json: async () => response.body };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PayRailsWarning — issue-time warning (#2754)', () => {
  it('warns when the issuer has neither a card rail nor an e-Transfer email, and points at both fixes', async () => {
    const spy = installRails({ ok: true, body: { card: false, emt: false } });
    render(<PayRailsWarning issuerDid={ISSUER} />);

    const warning = await screen.findByTestId('no-pay-rails-warning');

    expect(spy).toHaveBeenCalledWith(RAILS_URL, { credentials: 'include' });
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.textContent).toContain("can't be paid online");
    expect(screen.getByRole('link', { name: 'Connect your Stripe key' }).getAttribute('href')).toBe('/auth/connectors/stripe');
    expect(screen.getByRole('link', { name: 'add an e-Transfer email' }).getAttribute('href')).toBe('/auth/tax');
  });

  it.each([
    ['a card rail only', { card: true, emt: false }],
    ['an e-Transfer email only', { card: false, emt: true }],
    ['both', { card: true, emt: true }],
  ])('shows nothing when the issuer has %s', async (_label, body) => {
    const spy = installRails({ ok: true, body });
    render(<PayRailsWarning issuerDid={ISSUER} />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    await Promise.resolve();

    expect(screen.queryByTestId('no-pay-rails-warning')).toBeNull();
  });

  it.each([
    ['a non-OK response', { ok: false, body: {} }],
    ['an unexpected body', { ok: true, body: { card: 'yes' } }],
    ['a network failure', 'throw' as const],
  ])('stays hidden rather than guess on %s — a false alarm on every invoice would be worse than no warning', async (_label, response) => {
    const spy = installRails(response);
    render(<PayRailsWarning issuerDid={ISSUER} />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    await Promise.resolve();

    expect(screen.queryByTestId('no-pay-rails-warning')).toBeNull();
  });

  it('url-encodes the issuer DID', async () => {
    const spy = installRails({ ok: true, body: { card: true, emt: true } });
    render(<PayRailsWarning issuerDid="did:imajin:a b" />);

    await waitFor(() => expect(spy).toHaveBeenCalledWith('/pay/api/payment-requests/rails?issuer_did=did%3Aimajin%3Aa%20b', { credentials: 'include' }));
  });
});
