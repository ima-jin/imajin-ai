// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from '../ConnectorDetail';
import { slotRoute } from '../ConnectionSlots';

const navigation = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

const primary = { slot: 'primary', label: 'Personal', accountEmail: 'me@example.com', connected: true };
const work = { slot: 'work', label: 'Company', accountEmail: 'work@example.com', connected: true };
const status = { manifestAssetId: null, activeScopes: [], validScopes: [], configSealed: true, tokenSealed: true, flow: 'authorization_code' };

function setup(id = 'google', options: {
  connected?: boolean; configured?: boolean; failWrite?: boolean; failList?: boolean;
  flow?: string; deviceSuccess?: boolean; disconnectedWork?: boolean;
} = {}) {
  const entry = getConnector(id)!;
  const endpoint = `/connections/api/connectors/${id}/connections`;
  function deviceStart() {
    return options.deviceSuccess
      ? Response.json({ ticket: 'test-ticket', userCode: 'TEST-1234', verificationUri: 'https://github.com/login/device', interval: 1 })
      : Response.json({ error: 'Device test stopped' }, { status: 400 });
  }
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(endpoint)) {
      if (init?.method && options.failWrite) return Response.json({ error: 'Label was rejected' }, { status: 400 });
      if (!init?.method && options.failList) return Response.json({ error: 'Connections unavailable' }, { status: 503 });
      return Response.json({ connections: [primary, work] });
    }
    if (url.includes('/device/start')) return deviceStart();
    if (url.includes('/device/poll')) return Response.json({ status: 'authorized' });
    const disconnected = options.disconnectedWork && url.includes('slot=work');
    return Response.json({
      ...status,
      activeScopes: options.disconnectedWork && !disconnected ? ['google:gmail:read'] : [],
      tokenSealed: disconnected ? false : options.connected ?? true,
      configSealed: disconnected ? false : options.configured ?? true,
      ...(options.flow ? { flow: options.flow } : {}),
    });
  });
  vi.stubGlobal('fetch', fetch);
  render(<ConnectorDetail entry={entry} />);
  return { fetch, endpoint, entry };
}

afterEach(() => {
  cleanup();
  navigation.query = '';
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('labelled OAuth connections', () => {
  it.each(['google', 'github', 'quickbooks'])('shows both %s account labels and emails without opening the selector', async (id) => {
    const { fetch, entry } = setup(id);
    const list = await screen.findByRole('list', { name: 'Connection accounts' });
    expect(within(list).getByText('Personal')).toBeDefined();
    expect(within(list).getByText('me@example.com')).toBeDefined();
    expect(within(list).getByText('Company')).toBeDefined();
    expect(within(list).getByText('work@example.com')).toBeDefined();
    const primaryButton = within(list).getByRole('button', { name: /Personal/ });
    const workButton = within(list).getByRole('button', { name: /Company/ });
    expect(primaryButton.getAttribute('aria-pressed')).toBe('true');
    expect(workButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(workButton);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${entry.statusEndpoint}?slot=work`));
    expect(primaryButton.getAttribute('aria-pressed')).toBe('false');
    expect(workButton.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('combobox', { name: 'Selected connection' }) as HTMLSelectElement).value).toBe('work');
  });
  it.each(['google', 'github', 'quickbooks'])('lists labels and account emails for %s and defaults to primary', async (id) => {
    const { fetch, entry } = setup(id);
    const selector = await screen.findByRole('combobox', { name: 'Selected connection' });
    expect((selector as HTMLSelectElement).value).toBe('primary');
    expect(screen.getByRole('option', { name: /Personal.*me@example.com/ })).toBeDefined();
    expect(screen.getByRole('option', { name: /Company.*work@example.com/ })).toBeDefined();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(entry.statusEndpoint));
  });

  it.each(['google', 'github', 'quickbooks'])('threads selected %s slot through status, reconnect, scopes and disconnect', async (id) => {
    navigation.query = 'slot=work';
    const { fetch, entry } = setup(id);
    vi.stubGlobal('confirm', vi.fn(() => true));
    const link = await screen.findByRole('link', { name: 'Reconnect' });
    const href = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(href.searchParams.get('slot')).toBe('work');
    expect(href.searchParams.get('returnTo')).toBe(`/auth/connectors/${id}?slot=work`);
    expect(fetch).toHaveBeenCalledWith(`${entry.statusEndpoint}?slot=work`);
    const checkbox = screen.getAllByRole('checkbox').find((input) => !(input as HTMLInputElement).disabled)!;
    fireEvent.click(checkbox);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${entry.statusEndpoint}?slot=work`, expect.objectContaining({ method: 'POST' })));
    fireEvent.click(screen.getByRole('button', { name: /^Disconnect/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${entry.disconnectRoute}?slot=work`, { method: 'POST' }));
  });

  it.each(['google', 'github', 'quickbooks'])('posts BYO %s configuration to the selected slot', async (id) => {
    navigation.query = 'slot=work';
    const { fetch } = setup(id, { connected: false, configured: false });
    const clientId = await screen.findByPlaceholderText(id === 'github' ? 'OAuth App Client ID' : 'Client ID');
    fireEvent.change(clientId, { target: { value: 'client-id' } });
    const secret = screen.queryByPlaceholderText('Client Secret');
    if (secret) fireEvent.change(secret, { target: { value: 'test-client-secret' } });
    fireEvent.submit(clientId.closest('form')!);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/${id}/api/configure?slot=work`, expect.objectContaining({ method: 'POST' })));
  });

  it('switches connections without showing the old connection grants', async () => {
    const { fetch } = setup('google', { disconnectedWork: true });
    await screen.findByRole('link', { name: 'Reconnect' });
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Selected connection' }), { target: { value: 'work' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/google/api/scope-manifest?slot=work'));
    await screen.findByPlaceholderText('Client ID');
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(true);
    expect(window.location.search).toBe('?slot=work');
    expect((screen.getByRole('textbox', { name: 'Connection label' }) as HTMLInputElement).value).toBe('Company');
  });

  it('creates a labelled connection through the API before selecting it', async () => {
    const { fetch, endpoint } = setup();
    await screen.findByRole('combobox', { name: 'Selected connection' });
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New connection slot' }), { target: { value: 'second' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'New connection label' }), { target: { value: 'Second account' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Add connection' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ slot: 'second', label: 'Second account' }),
    })));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Selected connection' }) as HTMLSelectElement).value).toBe('second'));
    expect(fetch).toHaveBeenCalledWith('/google/api/scope-manifest?slot=second');
    expect(window.location.search).toBe('?slot=second');
  });

  it('persists a renamed label for only the selected slot', async () => {
    navigation.query = 'slot=work';
    const { fetch, endpoint } = setup();
    const label = await screen.findByRole('textbox', { name: 'Connection label' });
    fireEvent.change(label, { target: { value: 'New company name' } });
    fireEvent.submit(label.closest('form')!);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${endpoint}?slot=work`, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ label: 'New company name' }),
    })));
    expect(await screen.findByRole('option', { name: /New company name/ })).toBeDefined();
  });

  it('keeps the previous selection and label when a write fails', async () => {
    const { endpoint, fetch } = setup('google', { failWrite: true });
    const label = await screen.findByRole('textbox', { name: 'Connection label' });
    fireEvent.change(label, { target: { value: 'Rejected' } });
    fireEvent.submit(label.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Label was rejected');
    expect(screen.getByRole('option', { name: /Personal.*me@example.com/ })).toBeDefined();
    expect(fetch).toHaveBeenCalledWith(`${endpoint}?slot=primary`, expect.objectContaining({ method: 'PATCH' }));
  });

  it('does not borrow primary status for an unknown slot', async () => {
    navigation.query = 'slot=missing';
    const { fetch, entry } = setup();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connection not found. Choose a connection or add one.');
    expect(fetch).not.toHaveBeenCalledWith(entry.statusEndpoint);
    expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
  });

  it('fails closed when the connection list fails', async () => {
    const { fetch, entry } = setup('google', { failList: true });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connections unavailable');
    expect(fetch).not.toHaveBeenCalledWith(entry.statusEndpoint);
  });

  it('rejects invalid slots rather than displaying primary controls', async () => {
    navigation.query = 'slot=../other';
    const { fetch, entry } = setup();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid connection slot. Choose a valid connection.');
    expect(fetch).not.toHaveBeenCalledWith(entry.statusEndpoint);
  });

  it('uses the selected slot to start the GitHub device flow', async () => {
    navigation.query = 'slot=work';
    const { fetch } = setup('github', { connected: false, flow: 'device' });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with device flow →' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/github/api/device/start?slot=work', expect.objectContaining({ method: 'POST' })));
  });
  it('polls the device ticket in the same selected slot', async () => {
    navigation.query = 'slot=work';
    const { fetch } = setup('github', { connected: false, flow: 'device', deviceSuccess: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect with device flow →' }));
    expect(await screen.findByText('TEST-1234')).toBeDefined();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/github/api/device/poll?slot=work', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ ticket: 'test-ticket' }),
    })), { timeout: 2000 });
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) =>
      url === '/connections/api/connectors/github/connections')).toHaveLength(2));
  });

  it('preserves existing query and hash when adding a slot', () => {
    expect(slotRoute('/google/api/connect?app=shared#auth', 'work')).toBe('/google/api/connect?app=shared&slot=work#auth');
    expect(slotRoute('/google/api/connect', 'primary')).toBe('/google/api/connect');
  });
});
