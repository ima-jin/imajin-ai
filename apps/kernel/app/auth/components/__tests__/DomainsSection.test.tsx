// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DomainsSection from '../DomainsSection';

const did = 'did:imajin:owner';
const endpoint = `/auth/api/identities/${encodeURIComponent(did)}/domains`;
const pending = {
  domain: 'example.com', zoneOwner: did, siteOwner: did, appDid: null,
  method: 'dns-txt', status: 'pending', attestation: null, verifiedAt: null, checkedAt: null,
};

function installFetch(initial: object[] = []) {
  let domains = initial;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      domains = [];
      return new Response(null, { status: 204 });
    }
    if (init?.method === 'POST') {
      domains = _url.endsWith('/verify')
        ? [{ ...pending, status: 'verified', attestation: { signature: 'signed' }, checkedAt: '2026-10-17T00:00:00Z' }]
        : [pending];
      return Response.json({ domain: domains[0] });
    }
    return Response.json({ domains });
  });

  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('DomainsSection', () => {
  it('adds a domain, shows exact TXT proof, verifies and links signed evidence', async () => {
    const fetch = installFetch();
    render(<DomainsSection did={did} />);
    await screen.findByText('No domains added.');
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'example.com' } });
    fireEvent.change(screen.getByLabelText('Registered app DID (optional)'), { target: { value: 'did:imajin:app' } });
    fireEvent.click(screen.getByText('Add domain'));
    await screen.findByText('Name: _imajin.example.com');
    expect(screen.getByText(`Value: ${did}`)).toBeDefined();
    expect(screen.getByText('pending')).toBeDefined();
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST', credentials: 'include', body: JSON.stringify({ domain: 'example.com', appDid: 'did:imajin:app' }),
    }));
    expect(screen.queryByText('Signed evidence')).toBeNull();
    fireEvent.click(screen.getByText('Verify DNS'));
    await screen.findByText('verified');
    expect(screen.getByText('Signed evidence').getAttribute('href')).toBe(`${endpoint}/public?domain=example.com`);
    expect(screen.getByText(/Last checked:/)).toBeDefined();
    expect(fetch).toHaveBeenCalledWith(`${endpoint}/example.com/verify`, expect.objectContaining({ method: 'POST' }));
  });

  it('requires explicit confirmation for removal and allows cancellation', async () => {
    const fetch = installFetch([pending]);
    render(<DomainsSection did={did} />);
    await screen.findByText('example.com');
    fireEvent.click(screen.getByText('Remove'));
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Confirm remove')).toBeNull();
    fireEvent.click(screen.getByText('Remove'));
    fireEvent.click(screen.getByText('Confirm remove'));
    await screen.findByText('No domains added.');
    expect(fetch).toHaveBeenCalledWith(`${endpoint}/example.com`, expect.objectContaining({ method: 'DELETE' }));
  });

  it('shows ownership distinctions, Imajin issuance and legacy routing status', async () => {
    installFetch([
      { ...pending, domain: 'app.imajin.ai', method: 'imajin-issued', status: 'verified', siteOwner: 'did:imajin:site' },
      { ...pending, domain: 'legacy.example', method: 'legacy', status: 'legacy' },
    ]);
    render(<DomainsSection did={did} />);
    await screen.findByText('Issued by the Imajin organization.');
    expect(screen.getByText('Site owner: did:imajin:site')).toBeDefined();
    expect(screen.getByText('Routing only — not verified ownership.')).toBeDefined();
    expect(screen.queryByText('Verify DNS')).toBeNull();
    expect(screen.queryByText('Signed evidence')).toBeNull();
  });

  it('shows authentication failures instead of an empty successful list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Active identity owner or admin required' }, { status: 403 })));
    render(<DomainsSection did={did} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Active identity owner or admin required');
    expect(screen.queryByText('No domains added.')).toBeNull();
  });

  it('preserves pending instructions and displays DNS verification failures', async () => {
    const fetch = installFetch([pending]);
    render(<DomainsSection did={did} />);
    await screen.findByText('Verify DNS');
    fetch.mockResolvedValueOnce(Response.json({ error: 'TXT proof does not match' }, { status: 422 }));
    fireEvent.click(screen.getByText('Verify DNS'));
    expect((await screen.findByRole('alert')).textContent).toBe('TXT proof does not match');
    expect(screen.getByText('Name: _imajin.example.com')).toBeDefined();
  });

  it('handles failed additions without clearing the submitted domain', async () => {
    const fetch = installFetch();
    render(<DomainsSection did={did} />);
    await screen.findByText('No domains added.');
    fetch.mockResolvedValueOnce(Response.json({}, { status: 409 }));
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByText('Add domain'));
    expect((await screen.findByRole('alert')).textContent).toBe('Domain operation failed');
    expect((screen.getByLabelText('Domain') as HTMLInputElement).value).toBe('example.com');
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      body: JSON.stringify({ domain: 'example.com', appDid: null }),
    }));
  });

  it('handles network failures and aborts a pending load on unmount', async () => {
    const fetch = installFetch();
    fetch.mockRejectedValueOnce(new Error('Network unavailable'));
    const { unmount } = render(<DomainsSection did={did} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Network unavailable');
    const signal = fetch.mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('does not offer ownership mutations for an app whose zone belongs to Imajin', async () => {
    installFetch([{ ...pending, zoneOwner: 'did:imajin:imajin', method: 'imajin-issued', status: 'verified' }]);
    render(<DomainsSection did={did} />);
    await screen.findByText('Read-only: managed by the DNS zone owner.');
    expect(screen.queryByText('Remove')).toBeNull();
    expect(screen.queryByText('Verify DNS')).toBeNull();
  });

  it('requires re-addition before re-verifying a revoked claim', async () => {
    installFetch([{ ...pending, status: 'revoked' }]);
    render(<DomainsSection did={did} />);
    await screen.findByText('Re-add this domain above before verifying again.');
    expect(screen.queryByText('Remove')).toBeNull();
    expect(screen.queryByText('Verify DNS')).toBeNull();
  });

  it('disables add while initial evidence is loading', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<DomainsSection did={did} />);
    expect(screen.getByRole('status').textContent).toBe('Loading domains…');
    expect((screen.getByText('Add domain') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByLabelText('Domain') as HTMLInputElement).disabled).toBe(true));
  });
});
