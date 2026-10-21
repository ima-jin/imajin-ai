// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    expect(screen.getAllByText('Created')).toHaveLength(3);
    expect(screen.getAllByText('Last seen')).toHaveLength(3);
    expect(screen.getAllByText('unknown (pre-#3006 row)').length).toBeGreaterThan(0);
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
});
