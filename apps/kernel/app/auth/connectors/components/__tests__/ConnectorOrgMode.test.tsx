// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CONNECTOR_REGISTRY, getConnector } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from '../ConnectorDetail';
import type { OrgConnectorMode } from '../OrgConnectorSection';

const orgDid = 'did:imajin:artifact';
const actorDid = 'did:imajin:admin';
const loadedAt = '2026-11-06T16:00:00.000Z';
const mode = (canManage = true): OrgConnectorMode => ({
  kind: 'org', orgDid, canManage, members: [], statusUnavailable: false,
  initial: { provider: 'anthropic', status: 'loaded', loadedByDid: actorDid, loadedAt },
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function providerTransport() {
  let billingLoaded = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/grants')) return Response.json({ grants: [] });
    if (url.endsWith('/models')) return Response.json({
      models: [{ id: 'test-model', name: 'Test model' }], currentModelId: 'test-model',
    });
    if (url.endsWith('/billing-key')) {
      if (init?.method === 'POST') billingLoaded = true;
      if (init?.method === 'DELETE') billingLoaded = false;
      return Response.json({ keySealed: billingLoaded, loadedByDid: actorDid, loadedAt });
    }
    if (url.endsWith('/settings')) return Response.json({ environmentId: 'test-environment' });
    return Response.json({ activeScopes: [], validScopes: [], manifestAssetId: null });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('shared provider parity in org mode', () => {
  it('uses shared billing/model sections, live test and scope controls with only org headers/routes', async () => {
    const fetch = providerTransport();
    render(<ConnectorDetail entry={getConnector('anthropic')!} mode={mode()} />);
    const model = await screen.findByRole('combobox', { name: 'Default model' });
    expect((model as HTMLSelectElement).value).toBe('test-model');
    expect((model as HTMLSelectElement).disabled).toBe(false);
    expect(screen.getByRole('region', { name: 'Billing (admin) key' })).toBeDefined();
    const input = await screen.findByLabelText('Billing (admin) key', { selector: 'input' }) as HTMLInputElement;
    const value = crypto.randomUUID();
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe('');
    await screen.findByText('Billing key loaded');
    expect(document.body.textContent).not.toContain(value);
    fireEvent.change(model, { target: { value: 'test-model' } });
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => url.endsWith('/models') && init?.method === 'PUT')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Test connection / refresh models' }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('/models')).length).toBeGreaterThan(2));
    for (const [url, init] of fetch.mock.calls) {
      expect(url.startsWith('/connections/api/org-held/anthropic')).toBe(true);
      expect(init?.headers).toMatchObject({ 'X-Acting-As': orgDid });
    }
  });
  it('renders shared Warp settings and sends save and clear to the org route', async () => {
    const fetch = providerTransport();
    render(<ConnectorDetail entry={getConnector('warp')!} mode={mode()} />);
    const input = await screen.findByLabelText('Default Environment') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('test-environment'));
    fireEvent.change(input, { target: { value: 'another-environment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/connections/api/org-held/warp/settings', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ environmentId: 'another-environment' }),
    })));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/connections/api/org-held/warp/settings', expect.objectContaining({ method: 'DELETE' })));
  });
  it('keeps billing, model and scopes visible but non-manageable for a member, with no admin reads', async () => {
    const fetch = providerTransport();
    render(<ConnectorDetail entry={getConnector('anthropic')!} mode={mode(false)} />);
    expect(await screen.findByRole('combobox', { name: 'Default model' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('region', { name: 'Billing (admin) key' })).toBeDefined();
    expect(screen.queryByLabelText(/write-only/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('checkbox').every(input => input.matches(':disabled'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(CONNECTOR_REGISTRY.filter(entry => !entry.backendPending
    && ['static-secret', 'token-paste'].includes(entry.ingestionPattern)))(
    'keeps declared sections on $id and explains unsupported sections without personal fallbacks', async entry => {
      const fetch = providerTransport();
      render(<ConnectorDetail entry={entry} mode={mode()} />);
      await screen.findByRole('article', { name: `${entry.name} org service key` });
      if (entry.modelsRoute) expect(await screen.findByRole('combobox', { name: 'Default model' })).toBeDefined();
      if (entry.billingCredential) expect(screen.getByRole('region', { name: 'Billing (admin) key' })).toBeDefined();
      if (entry.settings) expect(await screen.findByLabelText(entry.settings.fields[0].label)).toBeDefined();
      if (!['anthropic', 'warp'].includes(entry.id)) expect(screen.getAllByRole('link', { name: 'Provider parity follow-up' })
        .every(link => link.getAttribute('href') === 'https://github.com/ima-jin/imajin-ai/issues/3341')).toBe(true);
      expect(fetch.mock.calls.every(([url]) => url.startsWith('/connections/api/org-held/'))).toBe(true);
    });
  it.each(CONNECTOR_REGISTRY.filter(entry => !entry.backendPending
    && ['static-secret', 'token-paste'].includes(entry.ingestionPattern)))(
    'keeps $id status-only for members, with no secret fields, management buttons or admin requests', async entry => {
      const fetch = providerTransport();
      render(<ConnectorDetail entry={entry} mode={mode(false)} />);
      await screen.findByRole('article', { name: `${entry.name} org service key` });
      expect(screen.queryByRole('button')).toBeNull();
      expect(document.querySelector('input[type="password"]')).toBeNull();
      if (entry.modelsRoute) expect(await screen.findByRole('combobox', { name: 'Default model' })).toHaveProperty('disabled', true);
      expect(fetch).not.toHaveBeenCalled();
    });
  it.each(['loadedByDid', 'loadedAt'])('never labels legacy billing custody loaded without %s', async field => {
    const fetch = providerTransport();
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => url.endsWith('/billing-key')
      ? Response.json({ keySealed: true, loadedByDid: actorDid, loadedAt, [field]: null })
      : original(url, init));
    render(<ConnectorDetail entry={getConnector('anthropic')!} mode={mode()} />);
    const billing = within(screen.getByRole('region', { name: 'Billing (admin) key' }));
    expect(await billing.findByText('Not loaded — re-load here')).toBeDefined();
    expect(billing.queryByText('Billing key loaded')).toBeNull();
    expect(billing.queryByRole('button', { name: 'Rotate billing key' })).toBeNull();
  });
});
