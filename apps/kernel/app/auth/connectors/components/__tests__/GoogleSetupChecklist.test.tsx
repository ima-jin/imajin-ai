// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GOOGLE_SETUP_STEPS, type GoogleSetupView } from '@/src/lib/google/setup-content';
import { GoogleSetupChecklist } from '../GoogleSetupChecklist';
import { ConnectorDetail } from '../ConnectorDetail';
import { getConnector, type ConnectorEntry } from '@/src/lib/kernel/connector-registry';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

function initialView(): GoogleSetupView {
  return {
    version: 1, slot: 'work',
    steps: Object.fromEntries(GOOGLE_SETUP_STEPS.map(({ id }) => [id, { status: 'not_started', pendingSince: null, updatedAt: null }])) as GoogleSetupView['steps'],
    businessProfileEnabled: false, businessProfileApproved: false, businessProfileAvailable: false,
    configSealed: false, tokenSealed: false, credentialPending: false,
  };
}
let saved: GoogleSetupView;
let failUpdate: boolean;
const onChange = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  saved = initialView(); failUpdate = false; onChange.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/connections/api/')) return Response.json({ connections: [{ slot: 'primary', label: 'Primary', connected: false, accountEmail: null }] });
    if (url.includes('/scope-manifest')) return Response.json({ manifestAssetId: null, activeScopes: [], validScopes: [], configSealed: false, tokenSealed: false });
    if (init?.method === 'PATCH') {
      if (failUpdate) return Response.json({ error: 'Save failed; please retry.' }, { status: 500 });
      const body = JSON.parse(String(init.body));
      saved.steps[body.step as keyof typeof saved.steps] = {
        status: body.status, pendingSince: body.status === 'pending_google' ? '2026-10-17T12:00:00Z' : null,
        updatedAt: '2026-10-17T12:00:00Z', ...(body.caseUrl ? { caseUrl: body.caseUrl } : {}),
      };
    }
    return Response.json(saved);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Google guided admin UI', () => {
  it('renders all six data-driven steps, five states, links, and credential-free instructions', async () => {
    render(<GoogleSetupChecklist slot="work" revision="0" onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ version: 1 })));
    for (const step of GOOGLE_SETUP_STEPS) {
      expect(screen.getByRole('heading', { name: `${GOOGLE_SETUP_STEPS.indexOf(step) + 1}. ${step.title}` })).toBeDefined();
      expect((screen.getByRole('combobox', { name: `${step.title} status` }) as HTMLSelectElement).options).toHaveLength(5);
    }
    expect(screen.getByRole('link', { name: 'Request Business Profile API access' }).getAttribute('href')).toBe('https://support.google.com/business/contact/api_default');
    expect(screen.getByRole('link', { name: 'Use the sealed configure form below' }).getAttribute('href')).toBe('#google-oauth-configure');
    expect(fetchMock).toHaveBeenCalledWith('/google/api/setup?slot=work', { cache: 'no-store' });
  });

  it('saves pending state and shows durable waiting time and rejection instructions after remount', async () => {
    const first = render(<GoogleSetupChecklist slot="work" revision="0" onChange={onChange} />);
    const select = await screen.findByRole('combobox', { name: 'Submit the Business Profile API access request status' });
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'pending_google' } });
    await screen.findByText(/Pending Google approval for Submit/);
    expect(document.querySelector('time')?.dateTime).toBe('2026-10-17T12:00:00Z');
    expect(screen.getByText(/If rejected, follow the Google case response/)).toBeDefined();
    first.unmount();
    render(<GoogleSetupChecklist slot="work" revision="1" onChange={onChange} />);
    await screen.findByText(/Pending Google approval for Submit/);
    expect(document.querySelector('time')?.dateTime).toBe('2026-10-17T12:00:00Z');
  });

  it('saves the Google case URL without arbitrary notes and does not optimistically approve failed writes', async () => {
    render(<GoogleSetupChecklist slot="work" revision="0" onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ version: 1 })));
    const input = screen.getByRole('textbox', { name: 'Google Business Profile support case URL' });
    fireEvent.change(input, { target: { value: 'https://support.google.com/business/thread/123' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByRole('link', { name: 'Open saved Google case' });
    failUpdate = true;
    const select = screen.getByRole('combobox', { name: 'Submit the Business Profile API access request status' }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'approved' } });
    await screen.findByRole('alert');
    expect(select.value).toBe('not_started');
    expect(screen.getByText(/Business Profile: disabled/)).toBeDefined();
  });

  it('retains instructions on load failure and recovers with reload', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    render(<GoogleSetupChecklist slot="work" revision="0" onChange={onChange} />);
    await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: 'Enable Search Console API' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Reload setup' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ slot: 'work' }));
  });

  it('performs a live check without changing admin-reported Google approval', async () => {
    render(<GoogleSetupChecklist slot="work" revision="0" onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ version: 1 })));
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/google/api/setup?slot=work', { method: 'POST', cache: 'no-store' }));
    expect(saved.steps['business-access'].status).toBe('not_started');
  });

  function googleEntry(): ConnectorEntry {
    return { ...getConnector('google')!, scopes: [
      { name: 'google:search-console:read', label: 'Read Search Console', releaseClass: 'owner-only' },
      { name: 'google:business-profile:read', label: 'Read Business Profile', releaseClass: 'owner-only' },
    ] as ConnectorEntry['scopes'] };
  }

  it('permits Search Console scope selection before first consent, but gates Business and masks vault import', async () => {
    render(<ConnectorDetail entry={googleEntry()} />);
    const search = await screen.findByRole('checkbox', { name: 'Read Search Console' });
    expect((search as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Read Business Profile' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('OAuth client ID') as HTMLInputElement).type).toBe('password');
    expect((screen.getByLabelText('OAuth client secret') as HTMLInputElement).type).toBe('password');
    expect(document.getElementById('google-oauth-configure')).not.toBeNull();
    expect(document.getElementById('google-account-connect')).not.toBeNull();
  });

  it('unlocks Business scope only after both server-reported gates permit it', async () => {
    saved.businessProfileApproved = true;
    saved.businessProfileEnabled = true;
    saved.businessProfileAvailable = true;
    render(<ConnectorDetail entry={googleEntry()} />);
    const business = await screen.findByRole('checkbox', { name: 'Read Business Profile' }) as HTMLInputElement;
    await waitFor(() => expect(business.disabled).toBe(false));
  });

  it('aligns Google controls with checklist steps and disables import until every field is present', async () => {
    const first = render(<ConnectorDetail entry={googleEntry()} />);
    let button = await screen.findByRole('button', { name: 'Save config' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.querySelector('#google-oauth-configure h3 span')?.textContent).toBe('5');
    expect(document.querySelector('#google-account-connect h3 span')?.textContent).toBe('6');
    expect(screen.getByText('Import the OAuth client into this identity vault first.')).toBeDefined();
    expect(screen.queryByText('Complete step 1 first.')).toBeNull();
    const clientId = screen.getByLabelText('OAuth client ID') as HTMLInputElement;
    const secret = screen.getByLabelText('OAuth client secret') as HTMLInputElement;
    const redirect = screen.getByLabelText('OAuth redirect URI') as HTMLInputElement;
    expect(clientId.autocomplete).toBe('new-password');
    expect(secret.autocomplete).toBe('new-password');
    fireEvent.change(clientId, { target: { value: 'mock-client-id' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(secret, { target: { value: 'mock-client-secret' } });
    expect(button.disabled).toBe(false);
    fireEvent.change(redirect, { target: { value: '' } });
    expect(button.disabled).toBe(true);
    fireEvent.submit(clientId.closest('form')!);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/configure'))).toBe(false);
    first.unmount();
    render(<ConnectorDetail entry={googleEntry()} />);
    button = await screen.findByRole('button', { name: 'Save config' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getByLabelText('OAuth client ID') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('OAuth client secret') as HTMLInputElement).value).toBe('');
  });

  it('refreshes approval after client import even when vault sealed flags have not changed', async () => {
    saved.configSealed = true;
    saved.businessProfileApproved = true;
    saved.businessProfileEnabled = true;
    saved.businessProfileAvailable = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/connections/api/')) return Response.json({ connections: [{ slot: 'primary', label: 'Primary', connected: false, accountEmail: null }] });
      if (url.includes('/scope-manifest')) return Response.json({ manifestAssetId: null, activeScopes: [], validScopes: [], configSealed: true, tokenSealed: false });
      if (url.includes('/configure') && init?.method === 'POST') {
        saved.businessProfileApproved = false;
        saved.businessProfileAvailable = false;
      }
      return Response.json(saved);
    });
    render(<ConnectorDetail entry={googleEntry()} />);
    const business = await screen.findByRole('checkbox', { name: 'Read Business Profile' }) as HTMLInputElement;
    await waitFor(() => expect(business.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    const clientId = screen.getByLabelText('OAuth client ID') as HTMLInputElement;
    const secret = screen.getByLabelText('OAuth client secret') as HTMLInputElement;
    fireEvent.change(clientId, { target: { value: 'mock-client-id' } });
    fireEvent.change(secret, { target: { value: 'mock-client-secret' } });
    fireEvent.submit(clientId.closest('form')!);
    await waitFor(() => expect(business.disabled).toBe(true));
    expect(screen.getByText(/Business Profile: disabled/)).toBeDefined();
    expect(screen.queryByDisplayValue('mock-client-id')).toBeNull();
    expect(screen.queryByDisplayValue('mock-client-secret')).toBeNull();
  });
});
