// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from '../ConnectorDetail';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

const entry = getConnector('stripe')!;
function mount(status: Record<string, unknown> = {}, sealFailure?: string) {
  let paired = status.publishableKeySealed === true;
  let primary = status.keySealed !== false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === entry.tokenRoute && init?.method === 'POST') {
      if (sealFailure) return new Response(JSON.stringify({ error: sealFailure, code: 'stripe_key_mode_mismatch', field: 'publishableKey' }), { status: 400 });
      paired = true;
      primary = true;
      return new Response(JSON.stringify({ sealed: true }), { status: 201 });
    }
    return new Response(JSON.stringify({
      manifestAssetId: null, activeScopes: ['stripe:events'],
      validScopes: ['stripe:events'], ...status, keySealed: primary, publishableKeySealed: paired,
    }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<ConnectorDetail entry={entry} />);
  return fetchMock;
}
function fill(label: string, value: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}
function submit() {
  fireEvent.submit(screen.getByLabelText('Restricted Key').closest('form')!);
}
function posts(mock: ReturnType<typeof mount>) {
  return mock.mock.calls.filter(([, init]) => init?.method === 'POST');
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Stripe paired-key connector card', () => {
  it('shows existing restricted-key-only sellers what is missing and does not claim connected', async () => {
    mount({ publishableKeySealed: false });
    expect(await screen.findByText(/Publishable key missing/)).toBeDefined();
    expect(screen.getByLabelText('Restricted Key')).toBeDefined();
    expect(screen.getByLabelText('Publishable Key')).toBeDefined();
    expect(screen.queryByText('● Connected')).toBeNull();
    expect((screen.getByRole('button', { name: 'Replace Stripe keys' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('declares the second field in the registry instead of a per-id card dispatcher', () => {
    expect(entry.credentialUi?.additionalField).toMatchObject({
      key: 'publishableKey', sealedFlag: 'publishableKeySealed', validation: 'stripe-key-pair',
    });
  });
  it('submits both trimmed keys through the same seal route then clears both inputs', async () => {
    const mock = mount({ keySealed: false });
    await screen.findByLabelText('Restricted Key');
    const restricted = fill('Restricted Key', ' rk_test_fake ');
    const publishable = fill('Publishable Key', ' pk_test_fake ');
    expect(restricted.type).toBe('password'); expect(publishable.type).toBe('password');
    submit();
    await screen.findByText('Publishable Key sealed');
    expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ token: 'rk_test_fake', publishableKey: 'pk_test_fake' });
    expect(screen.queryByText(/Publishable key missing/)).toBeNull();
    expect(screen.queryByLabelText('Restricted Key')).toBeNull();
    expect(screen.queryByLabelText('Publishable Key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect((screen.getByLabelText('Restricted Key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Publishable Key') as HTMLInputElement).value).toBe('');
  });
  it('fails closed with a named missing publishable field even for direct form submission', async () => {
    const mock = mount();
    await screen.findByLabelText('Restricted Key');
    fill('Restricted Key', 'rk_test_fake'); submit();
    await waitFor(() => {
      const matches = screen.getAllByText(/publishable.?key.*(missing|required)|missing.*publishable/i);
      expect(matches.length).toBeGreaterThan(0);
    });
    expect(posts(mock)).toHaveLength(0);
  });
  it.each([
    ['rk_test_fake', 'pk_live_fake'],
    ['rk_live_fake', 'pk_test_fake'],
  ])('refuses a live/test mismatch before sending either credential', async (token, publishableKey) => {
    const mock = mount();
    await screen.findByLabelText('Restricted Key');
    fill('Restricted Key', token); fill('Publishable Key', publishableKey); submit();
    expect(await screen.findByText(/same Stripe mode|mode.*match|match.*mode/i)).toBeDefined();
    expect(posts(mock)).toHaveLength(0);
  });
  it('refuses a non-publishable prefix without a credential POST', async () => {
    const mock = mount();
    await screen.findByLabelText('Restricted Key');
    fill('Restricted Key', 'rk_test_fake'); fill('Publishable Key', 'not-a-publishable-key'); submit();
    expect(await screen.findByText(/pk_test_|pk_live_|publishable.*invalid/i)).toBeDefined();
    expect(posts(mock)).toHaveLength(0);
  });
  it('shows both sealed statuses without exposing stored values', async () => {
    mount({ publishableKeySealed: true });
    expect(await screen.findByText('Publishable Key sealed')).toBeDefined();
    expect(screen.getByText('Restricted Key sealed')).toBeDefined();
    expect(screen.getByText('● Connected')).toBeDefined();
    expect(screen.queryByLabelText('Publishable Key')).toBeNull();
  });
  it('surfaces the safe backend validation error and retains the form for correction', async () => {
    mount({}, 'Publishable key mode must match restricted key mode');
    await screen.findByLabelText('Restricted Key');
    fill('Restricted Key', 'rk_test_fake'); fill('Publishable Key', 'pk_test_fake'); submit();
    expect(await screen.findByText(/Publishable key mode must match/)).toBeDefined();
    expect(screen.getByLabelText('Publishable Key')).toBeDefined();
    expect(screen.queryByText('● Connected')).toBeNull();
  });
});
