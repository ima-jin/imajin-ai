// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgreementPreview, { FIXTURE_CONTENT, fixtureRequestUrl } from '../agreement-preview';
import AgreementPreviewPage from '../page';
import { GET } from '../document/route';

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not-found'); } }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('agreement development preview', () => {
  it('handles each fetch request input without default object stringification', () => {
    expect(fixtureRequestUrl('/relative')).toBe('/relative');
    expect(fixtureRequestUrl(new URL('https://fixture.example/document'))).toBe('https://fixture.example/document');
    expect(fixtureRequestUrl(new Request('https://fixture.example/document'))).toBe('https://fixture.example/document');
  });
  it.each(['production', 'test'])('refuses preview page and fixture document outside development (%s)', (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    expect(() => AgreementPreviewPage()).toThrow('not-found');
    expect(() => GET()).toThrow('not-found');
  });
  it('serves matching fixture bytes only in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(AgreementPreviewPage()).toBeDefined();
    expect(await GET().text()).toBe(FIXTURE_CONTENT);
  });
  it('uses the real signing and revoke controls and restores transport on unmount', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubGlobal('confirm', vi.fn(() => true));
    const originalFetch = globalThis.fetch;
    const { unmount } = render(<AgreementPreview />);
    expect(screen.getByText(/Development fixture only/)).toBeDefined();
    expect(screen.getAllByText('Imajin Studio').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Sign', exact: true }));
    await screen.findByText('executed');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke', exact: true }));
    await screen.findByText('revoked', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'Organization account' }));
    await screen.findByText('Organization attestations');
    expect(screen.queryByRole('button', { name: 'Sign', exact: true })).toBeNull();
    unmount();
    expect(globalThis.fetch).toBe(originalFetch);
  });
  it('demonstrates matching-file and tamper states through the real verifier', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    render(<AgreementPreview />);
    const file = new File(['fixture'], 'fixture.txt');
    Object.defineProperty(file, 'text', { value: async () => FIXTURE_CONTENT });
    fireEvent.change(screen.getByLabelText('Verify a saved document'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify file' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Verified:'));
    const tampered = new File(['changed'], 'changed.txt');
    Object.defineProperty(tampered, 'text', { value: async () => 'changed' });
    fireEvent.change(screen.getByLabelText('Verify a saved document'), { target: { files: [tampered] } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify file' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('tampered'));
  });
});
