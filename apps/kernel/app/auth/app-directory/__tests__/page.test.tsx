// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AppDirectoryPage from '../page';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@imajin/ui/server', () => ({ getActingAsHeaders: () => ({ 'X-Acting-As': 'group-did' }) }));

const app = (overrides: Record<string, unknown> = {}) => ({
  slug: 'new-app', name: 'New App', icon: '★', description: 'An app from the registry',
  entryUrl: '/new-app', placements: ['launcher'], requiredScope: null, tier: 'third_party',
  featured: false, added: false, authorized: false, available: true, ...overrides,
});
const request = vi.fn();
const response = (apps: ReturnType<typeof app>[]) => Response.json({ apps });

beforeEach(() => {
  refresh.mockReset();
  request.mockReset().mockResolvedValue(response([app()]));
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('App directory', () => {
  it('loads registry metadata and shows scope, added, featured, and authorization states', async () => {
    request.mockResolvedValue(response([
      app({ featured: true, added: true, authorized: true }),
      app({ slug: 'scoped', name: 'Scoped', icon: null, description: null, available: false, requiredScope: 'business' }),
    ]));
    render(<AppDirectoryPage />);
    expect(screen.getByText('Loading apps…')).toBeDefined();
    await screen.findByRole('heading', { name: 'New App' });
    expect(screen.getByText('★')).toBeDefined();
    expect(screen.getByText('An app from the registry')).toBeDefined();
    expect(screen.getByText('Featured')).toBeDefined();
    expect(screen.getByText('Added')).toBeDefined();
    expect(screen.getByText(/Authorized —/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'manage in Grants' }).getAttribute('href')).toBe('/jin#grants');
    expect(screen.getByText(/requires business scope/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Add Scoped' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('No description provided.')).toBeDefined();
    expect(request).toHaveBeenCalledWith('/auth/api/apps/directory', expect.objectContaining({
      credentials: 'include', cache: 'no-store', headers: { 'X-Acting-As': 'group-did' },
    }));
  });

  it('adds with PUT, locks mutations while busy, applies returned rows, and refreshes navigation', async () => {
    const changed = vi.fn();
    globalThis.addEventListener('imajin:apps-changed', changed);
    let finish: (value: Response) => void = () => undefined;
    render(<AppDirectoryPage />);
    await screen.findByRole('button', { name: 'Add New App' });
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Add New App' }));
    expect((screen.getByRole('button', { name: 'Adding… New App' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(response([app({ added: true })])); });
    expect(screen.getByText('Added')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove New App' })).toBeDefined();
    expect(request).toHaveBeenLastCalledWith('/auth/api/apps/new-app', expect.objectContaining({ method: 'PUT' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    globalThis.removeEventListener('imajin:apps-changed', changed);
  });

  it('removes with DELETE without implying authorization was revoked', async () => {
    request.mockResolvedValueOnce(response([app({ added: true, authorized: true })]))
      .mockResolvedValueOnce(response([app({ authorized: true })]));
    render(<AppDirectoryPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove New App' }));
    await screen.findByRole('button', { name: 'Add New App' });
    expect(request).toHaveBeenLastCalledWith('/auth/api/apps/new-app', expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByText(/Authorized —/)).toBeDefined();
    expect(screen.getByText(/Existing authorizations are unchanged/)).toBeDefined();
    expect(screen.queryByText('Added')).toBeNull();
  });

  it('shows load errors with retry and a registered-app empty state', async () => {
    request.mockRejectedValueOnce(new Error('Directory unavailable')).mockResolvedValueOnce(response([]));
    render(<AppDirectoryPage />);
    expect(await screen.findByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('No apps are registered yet.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains rows on failed mutation and lets the user retry', async () => {
    request.mockResolvedValueOnce(response([app()]))
      .mockResolvedValueOnce(Response.json({ error: 'Not allowed' }, { status: 403 }));
    render(<AppDirectoryPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add New App' }));
    expect(within(await screen.findByRole('alert')).getByText('Not allowed')).toBeDefined();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add New App' }) as HTMLButtonElement).disabled).toBe(false));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects malformed success responses rather than inventing app state', async () => {
    request.mockResolvedValueOnce(Response.json({}));
    render(<AppDirectoryPage />);
    expect(await screen.findByText('Unable to read the app directory.')).toBeDefined();
  });

  it('uses a safe fallback for server errors without an error message', async () => {
    request.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    render(<AppDirectoryPage />);
    expect(await screen.findByText('Unable to update the app directory.')).toBeDefined();
  });

  it('can remove a previously added app even when its scope is no longer available', async () => {
    request.mockResolvedValueOnce(response([app({ added: true, available: false })]))
      .mockResolvedValueOnce(response([]));
    render(<AppDirectoryPage />);
    const remove = await screen.findByRole('button', { name: 'Remove New App' });
    expect(screen.getByText('Unavailable for this identity.')).toBeDefined();
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(remove);
    await screen.findByText('No apps are registered yet.');
  });

  it('uses safe load and mutation messages for non-Error failures', async () => {
    request.mockRejectedValueOnce('offline').mockResolvedValueOnce(response([app()]));
    render(<AppDirectoryPage />);
    await screen.findByText('Unable to load apps.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Add New App' });
    request.mockRejectedValueOnce('offline');
    fireEvent.click(screen.getByRole('button', { name: 'Add New App' }));
    await screen.findByText('Unable to update apps.');
  });

  it('aborts mutation updates when switching identities', async () => {
    let finish: (value: Response) => void = () => undefined;
    render(<AppDirectoryPage />);
    await screen.findByRole('button', { name: 'Add New App' });
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response([]));
    fireEvent.click(screen.getByRole('button', { name: 'Add New App' }));
    act(() => { globalThis.dispatchEvent(new Event('imajin:session-changed')); });
    await screen.findByText('No apps are registered yet.');
    await act(async () => { finish(response([app({ added: true })])); });
    expect(screen.queryByText('Added')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores an old identity response after a scope change', async () => {
    let finish: (value: Response) => void = () => undefined;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response([]));
    render(<AppDirectoryPage />);
    act(() => { globalThis.dispatchEvent(new Event('imajin:acting-as-changed')); });
    await screen.findByText('No apps are registered yet.');
    await act(async () => { finish(response([app()])); });
    expect(screen.queryByRole('heading', { name: 'New App' })).toBeNull();
  });
});
