// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { VerifiedDomains } from '../VerifiedDomains';

const did = 'did:imajin:owner';
const signed = { domain: 'verified.example', status: 'verified', attestation: { signature: 'signed' } };
function abortableFetch(_url: string, init: RequestInit) {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('VerifiedDomains profile evidence', () => {
  it('fetches public-only evidence and shows verified site and signed proof links', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ domains: [
      signed, { ...signed, domain: 'pending.example', status: 'pending' },
      { ...signed, domain: 'legacy.example', status: 'legacy' },
      { ...signed, domain: 'revoked.example', status: 'revoked' },
      { ...signed, domain: 'unsigned.example', attestation: null },
    ] }));
    vi.stubGlobal('fetch', fetch);
    render(<VerifiedDomains did={did} />);
    const link = await screen.findByText('verified.example');
    expect(link.getAttribute('href')).toBe('https://verified.example');
    const endpoint = `/auth/api/identities/${encodeURIComponent(did)}/domains/public`;
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Signed evidence').getAttribute('href')).toBe(`${endpoint}?domain=verified.example`);
    expect(screen.queryByText('pending.example')).toBeNull();
    expect(screen.queryByText('legacy.example')).toBeNull();
    expect(screen.queryByText('revoked.example')).toBeNull();
    expect(screen.queryByText('unsigned.example')).toBeNull();
  });

  it('renders nothing when there are no verified domains', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ domains: [] }));
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<VerifiedDomains did={did} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(container.innerHTML).toBe('');
  });

  it('fails closed when public evidence lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 500 })));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(<VerifiedDomains did={did} />);
    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('aborts on unmount without logging aborted requests', async () => {
    const fetch = vi.fn(abortableFetch);
    vi.stubGlobal('fetch', fetch);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<VerifiedDomains did={did} />);
    unmount();
    await waitFor(() => expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true));
    expect(log).not.toHaveBeenCalled();
  });
});
