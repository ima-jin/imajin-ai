// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from '../ConnectorDetail';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

const entry = getConnector('stripe')!;
function mount(status: Record<string, unknown> = {}, sealFailure?: string, grantFailure?: string) {
  let paired = status.publishableKeySealed === true;
  let primary = status.keySealed !== false;
  let webhook = status.webhookSecretSealed === true;
  let activeScopes = (status.activeScopes ?? ['stripe:events']) as string[];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === entry.statusEndpoint && init?.method === 'POST') {
      if (grantFailure) return new Response(JSON.stringify({ error: grantFailure }), { status: 403 });
      activeScopes = JSON.parse(String(init.body)).scopes;
      return new Response(JSON.stringify({ activeScopes }));
    }
    if (url === entry.tokenRoute && init?.method === 'POST') {
      if (sealFailure) return new Response(JSON.stringify({ error: sealFailure, code: 'stripe_key_mode_mismatch', field: 'publishableKey' }), { status: 400 });
      paired = true;
      primary = true;
      if (String(init.body).includes('webhookSecret')) webhook = true;
      return new Response(JSON.stringify({ sealed: true }), { status: 201 });
    }
    return new Response(JSON.stringify({
      manifestAssetId: null,
      validScopes: ['stripe:events'], ...status, keySealed: primary, publishableKeySealed: paired,
      activeScopes,
      webhookSecretSealed: webhook, webhookUrl: 'https://kernel.test/pay/api/webhook/did/stripewh_fake',
      webhookEvents: ['payment_intent.succeeded', 'invoice.paid', 'payout.paid'],
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
const consentInstruction = 'Grant stripe:events to receive webhooks.';
const incompleteBadge = 'Incomplete — webhook consent required';
const sealedWithoutConsent = {
  keySealed: true, publishableKeySealed: true, webhookSecretSealed: true, activeScopes: [],
};
function eventsToggle() {
  return screen.getByRole('checkbox', { name: entry.scopes.find((scope) => scope.name === 'stripe:events')!.label }) as HTMLInputElement;
}

describe('Stripe webhook owner consent readiness', () => {
  it('makes the required grant obvious on a fresh card without selecting or posting it', async () => {
    const mock = mount({ keySealed: false, activeScopes: [] });
    expect(await screen.findByText(consentInstruction)).toBeDefined();
    expect(screen.getByText(/Sealing credentials does not grant it automatically/)).toBeDefined();
    expect(eventsToggle().checked).toBe(false);
    expect(eventsToggle().disabled).toBe(true);
    expect(screen.queryByText('● Connected')).toBeNull();
    expect(posts(mock)).toHaveLength(0);
  });
  it('shows an explicit incomplete HTTP 503 state when credentials are sealed without consent', async () => {
    const mock = mount(sealedWithoutConsent);
    expect(await screen.findByText(incompleteBadge)).toBeDefined();
    expect(screen.getByText(consentInstruction)).toBeDefined();
    expect(screen.getByText(/HTTP 503 connector_unavailable/)).toBeDefined();
    expect(eventsToggle().checked).toBe(false);
    expect(eventsToggle().disabled).toBe(false);
    expect(screen.queryByText('● Connected')).toBeNull();
    expect(posts(mock)).toHaveLength(0);
  });
  it('does not consider an unrelated active scope sufficient for webhook readiness', async () => {
    const mock = mount({ ...sealedWithoutConsent, activeScopes: ['stripe:other'] });
    expect(await screen.findByText(incompleteBadge)).toBeDefined();
    expect(screen.getByText(/HTTP 503 connector_unavailable/)).toBeDefined();
    expect(screen.getByRole('heading', { name: /Scope grants/ }).textContent).not.toContain('✓');
    expect(screen.queryByText('● Connected')).toBeNull();
    expect(posts(mock)).toHaveLength(0);
  });
  it('connects only after a successful explicit owner toggle, preserving other active scopes', async () => {
    const mock = mount({ ...sealedWithoutConsent, activeScopes: ['stripe:other'] });
    await screen.findByText(incompleteBadge);
    fireEvent.click(eventsToggle());
    expect(await screen.findByText('● Connected')).toBeDefined();
    expect(posts(mock)).toHaveLength(1);
    expect(posts(mock)[0][0]).toBe(entry.statusEndpoint);
    expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ scopes: ['stripe:other', 'stripe:events'] });
    expect(eventsToggle().checked).toBe(true);
    expect(screen.queryByText(consentInstruction)).toBeNull();
    expect(screen.queryByText(/HTTP 503 connector_unavailable/)).toBeNull();
  });
  it('retains the warning and unchecked scope when the owner grant fails', async () => {
    const mock = mount(sealedWithoutConsent, undefined, 'Owner approval required');
    await screen.findByText(incompleteBadge);
    fireEvent.click(eventsToggle());
    expect(await screen.findByText(/Owner approval required/)).toBeDefined();
    expect(screen.getByText(incompleteBadge)).toBeDefined();
    expect(screen.getByText(/HTTP 503 connector_unavailable/)).toBeDefined();
    expect(eventsToggle().checked).toBe(false);
    expect(screen.queryByText('● Connected')).toBeNull();
    expect(posts(mock)).toHaveLength(1);
  });
  it('returns to incomplete when the owner explicitly revokes the events grant', async () => {
    const mock = mount({ ...sealedWithoutConsent, activeScopes: ['stripe:events'] });
    await screen.findByText('● Connected');
    fireEvent.click(eventsToggle());
    expect(await screen.findByText(incompleteBadge)).toBeDefined();
    expect(screen.getByText(/HTTP 503 connector_unavailable/)).toBeDefined();
    expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ scopes: [] });
  });
  it('does not grant automatically after sealing the keys and webhook signing secret', async () => {
    const mock = mount({ keySealed: false, activeScopes: [] });
    await screen.findByLabelText('Restricted Key');
    fill('Restricted Key', 'rk_test_fake'); fill('Publishable Key', 'pk_test_fake'); submit();
    const input = await screen.findByLabelText('Webhook signing secret');
    fill('Webhook signing secret', 'whsec_fake_manual');
    fireEvent.submit(input.closest('form')!);
    await screen.findByText(incompleteBadge);
    expect(eventsToggle().checked).toBe(false);
    expect(posts(mock)).toHaveLength(2);
    expect(posts(mock).every(([url]) => url === entry.tokenRoute)).toBe(true);
    expect(screen.queryByText('● Connected')).toBeNull();
  });
});

describe('Stripe paired-key connector card', () => {
  it('lets an existing owner add a signing secret in the same card without re-entering keys', async () => {
    const mock = mount({ publishableKeySealed: true });
    const input = await screen.findByLabelText('Webhook signing secret') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(screen.queryByLabelText('Restricted Key')).toBeNull();
    expect(screen.queryByText('● Connected')).toBeNull();
    expect(await screen.findByText('https://kernel.test/pay/api/webhook/did/stripewh_fake')).toBeDefined();
    fill('Webhook signing secret', ' whsec_fake_entered ');
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('Webhook signing secret sealed');
    await screen.findByText('● Connected');
    expect(JSON.parse(String(posts(mock)[0][1]?.body))).toEqual({ webhookSecret: 'whsec_fake_entered' });
    expect((screen.getByLabelText('Webhook signing secret') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('whsec_fake_entered')).toBeNull();
  });
  it('rejects an invalid signing secret locally without sending it', async () => {
    const mock = mount({ publishableKeySealed: true });
    const input = await screen.findByLabelText('Webhook signing secret');
    fill('Webhook signing secret', 'fake_invalid');
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText(/Provide the webhook signing secret starting with whsec_/)).toBeDefined();
    expect(posts(mock)).toHaveLength(0);
  });
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
    mount({ publishableKeySealed: true, webhookSecretSealed: true });
    expect(await screen.findByText('Publishable Key sealed')).toBeDefined();
    expect(screen.getByText('Restricted Key sealed')).toBeDefined();
    expect(await screen.findByText('● Connected')).toBeDefined();
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
