// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MailDomainsPanel } from '../mail-domains-panel';
import { statusFixture } from '@/src/lib/mail/__tests__/postal-fixture';
import type { MailDomainStatus } from '@/src/lib/mail/postal-contract';

const ownerDid = 'did:imajin:org';
const url = `/jin/api/orgs/${encodeURIComponent(ownerDid)}/mail-domains`;
const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
function settings(state: MailDomainStatus['state'] = 'pending', error: string | null = null, spfError: string | null = null) {
  const status = statusFixture(state === 'verified');
  return {
    domains: [{
      ...status, state, error,
      guidance: { records: status.records.map(record => record.kind === 'spf'
        ? { ...record, value: 'v=spf1 include:spf.protection.outlook.com include:spf.postal.example -all' } : record), error: spfError },
    }],
    availableDomains: ['example.org', 'second.org'],
  };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function loaded(data = settings()) {
  const http = vi.fn().mockResolvedValue(json(data));
  vi.stubGlobal('fetch', http);
  render(<MailDomainsPanel ownerDid={ownerDid} />);
  await screen.findByRole('article', { name: 'Mail status for example.org' });
  return http;
}

describe('organization mail domain panel', () => {
  it('shows exact ownership/DKIM/return-path, merged M365 SPF, pending status and never MX instructions', async () => {
    const http = await loaded();
    expect(http).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'include', cache: 'no-store' }));
    expect(screen.getByText('example.org — pending')).toBeTruthy();
    expect(screen.getByText('postal-verification public DNS proof')).toBeTruthy();
    expect(screen.getByText('v=DKIM1; k=rsa; p=public-dns-key')).toBeTruthy();
    expect(screen.getByText('rp.postal.example')).toBeTruthy();
    expect(screen.getByText('v=spf1 include:spf.protection.outlook.com include:spf.postal.example -all')).toBeTruthy();
    expect(screen.queryByText('inbound.postal.example')).toBeNull();
    expect(screen.getByText(/never add a second SPF TXT/)).toBeTruthy();
  });
  it('provisions the explicitly selected verified owner domain then reloads persisted status', async () => {
    const http = await loaded();
    fireEvent.change(screen.getByLabelText('Verified owner domain'), { target: { value: 'second.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up domain mail' }));
    await waitFor(() => expect(http).toHaveBeenCalledTimes(3));
    expect(http).toHaveBeenNthCalledWith(2, url, expect.objectContaining({
      method: 'POST', credentials: 'include', body: JSON.stringify({ domain: 'second.org' }),
    }));
  });
  it('checks a pending domain and displays the verified response on reload', async () => {
    const http = await loaded();
    http.mockResolvedValueOnce(json({ domain: statusFixture(true) })).mockResolvedValueOnce(json(settings('verified')));
    fireEvent.click(screen.getByRole('button', { name: 'Check example.org' }));
    await screen.findByText('example.org — verified');
    expect(http).toHaveBeenNthCalledWith(2, `${url}/example.org/check`, expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText(/Last DNS check:/)).toBeTruthy();
  });
  it('renders disabled state without publishing instructions or check button', async () => {
    await loaded(settings('disabled'));
    expect(screen.getByText(/Sending disabled/)).toBeTruthy();
    expect(screen.queryByText('postal-verification public DNS proof')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check example.org' })).toBeNull();
  });
  it('shows provisioning and SPF lookup errors without treating failure as verification', async () => {
    await loaded(settings('pending', 'postal_unauthorized', 'spf_lookup_unavailable'));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByText(/Mail provisioning needs attention/)).toBeTruthy();
    expect(screen.getByText(/Never add a second SPF policy/)).toBeTruthy();
  });
  it('handles no verified domains and no stored states', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ domains: [], availableDomains: [] })));
    render(<MailDomainsPanel ownerDid={ownerDid} />);
    expect(screen.getByText('Loading mail domains…')).toBeTruthy();
    await screen.findByText(/No verified owner domains/);
    expect(screen.queryByRole('button', { name: 'Set up domain mail' })).toBeNull();
  });
  it.each([403, 500])('reports load failures %i', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, status)));
    render(<MailDomainsPanel ownerDid={ownerDid} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load mail domains');
  });
  it.each([403, 503])('reports mutation failure %i and reloads stored error state', async status => {
    const http = await loaded();
    http.mockResolvedValueOnce(json({}, status));
    fireEvent.click(screen.getByRole('button', { name: 'Set up domain mail' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Mail setup could not complete');
    await waitFor(() => expect(http).toHaveBeenCalledTimes(3));
  });
  it('reports network failure, blocks repeated clicks while busy, then allows retry', async () => {
    const http = await loaded();
    let reject!: (error: Error) => void;
    http.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const button = screen.getByRole('button', { name: 'Set up domain mail' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(http).toHaveBeenCalledTimes(2);
    reject(new Error('private network detail'));
    await screen.findByRole('alert');
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.queryByText('private network detail')).toBeNull();
  });
  it('refreshes stored pending status on an interval and stops polling once verified', async () => {
    vi.useFakeTimers();
    const http = vi.fn().mockResolvedValueOnce(json(settings())).mockResolvedValue(json(settings('verified')));
    vi.stubGlobal('fetch', http);
    await act(async () => { render(<MailDomainsPanel ownerDid={ownerDid} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(http).toHaveBeenCalledTimes(2);
    expect(screen.getByText('example.org — verified')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(http).toHaveBeenCalledTimes(2);
  });
  it('aborts an outstanding read on unmount and ignores late responses', async () => {
    let resolve!: (value: unknown) => void;
    const http = vi.fn().mockReturnValue(new Promise(done => { resolve = done; }));
    vi.stubGlobal('fetch', http);
    const view = render(<MailDomainsPanel ownerDid={ownerDid} />);
    const signal = http.mock.calls[0][1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(json(settings())); });
    expect(screen.queryByText('example.org — pending')).toBeNull();
  });
  it('manual refresh rereads state without making a Postal check request', async () => {
    const http = await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh mail status' }));
    await waitFor(() => expect(http).toHaveBeenCalledTimes(2));
    expect(http.mock.calls[1][0]).toBe(url);
    expect(http.mock.calls[1][1].method).toBeUndefined();
  });
});
