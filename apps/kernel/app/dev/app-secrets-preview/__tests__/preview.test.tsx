// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import AppSecretsPreview from '../app-secrets-preview';
import AppSecretsPreviewPage from '../page';

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not-found'); } }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('App secrets development preview', () => {
  it.each(['production', 'test'])('refuses the page outside development (%s)', (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    expect(() => AppSecretsPreviewPage()).toThrow('not-found');
  });
  it('renders real claimed, awaiting, and unknown cards and restores transport', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(AppSecretsPreviewPage()).toBeDefined();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<AppSecretsPreview />);
    expect(screen.getByText(/Development fixture only/)).toBeDefined();
    await screen.findByText('awaiting claim');
    expect(screen.getAllByText('Created')).toHaveLength(4);
    expect(screen.getAllByText('Last seen')).toHaveLength(9);
    expect(await screen.findByRole('region', { name: 'Registered apps' })).toBeDefined();
    expect(screen.getByText('provision failed')).toBeDefined();
    expect(screen.getAllByText('unknown (legacy record)').length).toBeGreaterThan(0);
    expect(screen.getByText(/Claim code expired/).textContent).toContain('2020-01-02T03:04:05Z');
    fireEvent.click(screen.getByRole('button', { name: 'Reissue claim code' }));
    expect(screen.getByText(/reissue reached the existing provision control/)).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: 'Sync manifest secrets' })[0]);
    await screen.findByText('Fixture only — no proposals are sent.');
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
    expect(globalThis.fetch).toBe(fetchMock);
  });
  it('does not install fixture transport outside development even when mounted directly', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const originalFetch = globalThis.fetch;
    render(<AppSecretsPreview />);
    expect(screen.queryByTestId('app-secrets-panel')).toBeNull();
    expect(globalThis.fetch).toBe(originalFetch);
  });
  it('simulates Clear locally without letting the development preview send real mutations', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const originalFetch = vi.fn();
    vi.stubGlobal('fetch', originalFetch);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<AppSecretsPreview />);
    const panel = await screen.findByRole('region', { name: 'Registered apps' });
    const row = within(panel).getByText('BrokerAgent fixture (zero consent)').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Clear' }));
    const history = (await within(panel).findByText('revoked (2)')).closest('details')!;
    expect(history.open).toBe(false);
    fireEvent.click(within(history).getByText('revoked (2)'));
    const revokedRow = within(history).getByText('BrokerAgent fixture (zero consent)').closest('li')!;
    expect(within(revokedRow).getByText('delegated app · revoked')).toBeDefined();
    expect(revokedRow.textContent).toContain('att_fixture_clear');
    expect(row.isConnected).toBe(false);
    expect(originalFetch).not.toHaveBeenCalled();
    expect((await fetch('/api/admin/registry/apps/not-a-fixture/revoke', { method: 'POST' })).status).toBe(404);
    expect(originalFetch).not.toHaveBeenCalled();
  });
});
