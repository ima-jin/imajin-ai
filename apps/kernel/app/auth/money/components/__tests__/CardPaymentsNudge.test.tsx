// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import CardPaymentsNudge from '../CardPaymentsNudge';

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

describe('CardPaymentsNudge (#2757)', () => {
  it('tells a seller with no card rail that card payments use their own Stripe key, and links to Connectors', async () => {
    const spy = installRails({ ok: true, body: { card: false, emt: true } });
    render(<CardPaymentsNudge issuerDid={ISSUER} />);

    const nudge = await screen.findByTestId('card-payments-nudge');

    expect(spy).toHaveBeenCalledWith(RAILS_URL, { credentials: 'include' });
    expect(nudge.textContent).toBe('Card payments now use your own Stripe key. Connect it under Connectors.');
    expect(screen.getByRole('link', { name: /connect it under connectors/i }).getAttribute('href')).toBe('/auth/connectors/stripe');
  });

  it('shows nothing once the seller has a working card rail', async () => {
    const spy = installRails({ ok: true, body: { card: true, emt: false } });
    render(<CardPaymentsNudge issuerDid={ISSUER} />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('card-payments-nudge')).toBeNull();
  });

  it.each([
    ['a non-OK answer', { ok: false, body: {} }],
    ['a malformed body', { ok: true, body: { nope: true } }],
    ['a network failure', 'throw' as const],
  ])('shows nothing on %s — never a false alarm', async (_label, response) => {
    const spy = installRails(response);
    render(<CardPaymentsNudge issuerDid={ISSUER} />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('card-payments-nudge')).toBeNull();
  });
});
