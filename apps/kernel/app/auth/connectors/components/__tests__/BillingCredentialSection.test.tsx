// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { ConnectorDetail } from '../ConnectorDetail';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount(provider: string, options: { sealed?: boolean; pending?: boolean; failure?: boolean; statusFailure?: boolean } = {}) {
  const entry = getConnector(provider)!;
  let keySealed = options.sealed ?? false;
  let credentialPending = options.pending ?? false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === entry.billingCredential!.route) {
      if (init?.method) {
        if (options.failure) return Response.json({ error: 'must never render provider details' }, { status: 403 });
        keySealed = init.method === 'POST';
        credentialPending = false;
        return Response.json({ sealed: keySealed });
      }
      if (options.statusFailure) return Response.json({}, { status: 503 });
      return Response.json({ keySealed, credentialPending });
    }
    return Response.json({ keySealed: false, activeScopes: [], validScopes: [], manifestAssetId: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<ConnectorDetail entry={entry} />);
  return { entry, fetchMock };
}
function fill(value: string) {
  const input = screen.getByLabelText('Billing (admin) key', { selector: 'input' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}
function submit() {
  fireEvent.submit(screen.getByLabelText('Billing (admin) key', { selector: 'input' }).closest('form')!);
}

describe.each(['anthropic', 'openai'])('%s billing slot on the connector card', (provider) => {
  it('seals through its billing route, unlocks only billing consent, never echoes, and rotates without prefill', async () => {
    const { entry, fetchMock } = mount(provider);
    await screen.findByText('billed: not connected');
    const scope = entry.scopes.find(({ name }) => name === `${provider}:billing`)!;
    const infer = entry.scopes.find(({ name }) => name === `${provider}:infer`)!;
    expect((screen.getByRole('checkbox', { name: scope.label }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Seal billing key' }) as HTMLButtonElement).disabled).toBe(true);
    const input = fill('  fixture-billing-value  ');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    submit();
    await screen.findByText('Billing key sealed');
    expect(fetchMock).toHaveBeenCalledWith(entry.billingCredential!.route, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ token: 'fixture-billing-value' }),
    }));
    expect((screen.getByRole('checkbox', { name: scope.label }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: infer.label }) as HTMLInputElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain('fixture-billing-value');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate billing key' }));
    expect(fill('').value).toBe('');
    fill('fixture-rotated-value'); submit();
    await waitFor(() => expect(screen.queryByLabelText('Billing (admin) key', { selector: 'input' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Rotate billing key' }));
    fill('fixture-cancelled-value');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate billing key' }));
    expect(fill('').value).toBe('');
  });
  it('revokes only the billing slot after confirmation and returns to a blank seal form', async () => {
    const { entry, fetchMock } = mount(provider, { sealed: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await screen.findByText('Billing key sealed');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke billing key' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke billing key' }));
    await screen.findByText('billed: not connected');
    expect(fetchMock).toHaveBeenCalledWith(entry.billingCredential!.route, { method: 'DELETE' });
    expect(fill('').value).toBe('');
  });
  it('clears a refused submission and never renders the returned error or claims sealed', async () => {
    mount(provider, { failure: true });
    await screen.findByText('billed: not connected');
    const input = fill('fixture-refused-value');
    submit();
    await screen.findByRole('alert');
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain('fixture-refused-value');
    expect(document.body.textContent).not.toContain('must never render provider details');
    expect(screen.queryByText('Billing key sealed')).toBeNull();
  });
  it('distinguishes pending approval from missing and keeps revoke available', async () => {
    mount(provider, { pending: true });
    await screen.findByText('Billing key awaiting owner approval');
    expect(screen.queryByLabelText('Billing (admin) key', { selector: 'input' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke billing key' })).toBeDefined();
  });
  it('does not offer a form when status cannot be read', async () => {
    mount(provider, { statusFailure: true });
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByLabelText('Billing (admin) key', { selector: 'input' })).toBeNull();
  });
});
