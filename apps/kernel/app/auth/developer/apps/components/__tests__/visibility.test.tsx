// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { APP_VISIBILITIES } from '@/src/lib/apps/visibility';
import RegisterAppForm from '../RegisterAppForm';
import AppDetailClient from '../../[appId]/components/AppDetailClient';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const app = {
  id: 'app_owner', appDid: 'did:imajin:app', publicKey: 'public',
  name: 'Owner app', description: null, callbackUrl: 'https://example.com/callback',
  homepageUrl: null, logoUrl: null, requestedScopes: [], status: 'active',
  visibility: 'private' as const, createdAt: null, updatedAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('developer visibility controls (#2897)', () => {
  it.each(APP_VISIBILITIES)('registers selected visibility %s', async visibility => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...app, visibility }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<RegisterAppForm onCancel={vi.fn()} onSuccess={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: 'App visibility' });
    expect((select as HTMLSelectElement).value).toBe('public');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(select.getAttribute('aria-describedby')).toBe('register-app-visibility-description register-app-visibility-web');
    expect(screen.getByText(/Public web pages remain public/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/App Name/), { target: { value: 'Owner app' } });
    fireEvent.change(screen.getByLabelText(/Callback URL/), { target: { value: app.callbackUrl } });
    fireEvent.change(select, { target: { value: visibility } });
    fireEvent.click(screen.getByRole('button', { name: 'Register App' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/registry/apps');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ visibility });
  });

  it.each(APP_VISIBILITIES)('edits and sends visibility %s', async visibility => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...app, visibility }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<AppDetailClient app={app} />);
    expect(screen.getByText(/private — Only the owning identity/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const select = screen.getByRole('combobox', { name: 'App visibility' });
    expect((select as HTMLSelectElement).value).toBe('private');
    fireEvent.change(select, { target: { value: visibility } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/registry/apps/app_owner');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ visibility });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy());
  });

  it('cancel restores the persisted visibility before a later edit', () => {
    render(<AppDetailClient app={app} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'public' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('private');
  });

  it('shows owner-countersign denial without losing the selected proposal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'AGENT_APPROVAL_REQUIRED', error: 'The owner must countersign' }),
    }));
    render(<AppDetailClient app={app} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'public' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(screen.getByText('The owner must countersign')).toBeTruthy());
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('public');
  });
});
