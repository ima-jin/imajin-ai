// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OrgHeldRenewalForm } from '../org-held-renewal-form';
import { VaultRenewalApproval } from '../vault-renewal-approval';
import Page from '../vault/renew/page';

const acting = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
vi.mock('@imajin/ui/server', () => ({ getActingAsHeaders: () => acting.headers }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); acting.headers = {}; });
const orgDid = 'did:imajin:artifact';
function fill() {
  const input = screen.getByLabelText('New grant expiry (local time)');
  const expiry = new Date(Date.now() + 86400_000).toISOString().slice(0, 16);
  fireEvent.change(input, { target: { value: expiry } });
  return expiry;
}
describe('org-held renewal control', () => {
  it.each([false, true])('proposes metadata in personal / org acting context=%s, then directs the owner to sign', async asOrg => {
    if (asOrg) acting.headers = { 'X-Acting-As': orgDid };
    const fetch = vi.fn().mockResolvedValue(Response.json({ proposalId: 'proposal', status: 'pending' }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    render(<OrgHeldRenewalForm orgDid={orgDid} provider="anthropic" />);
    expect(screen.getByRole('button', { name: 'Propose renewal' }).hasAttribute('disabled')).toBe(true);
    expect(document.querySelector('input[type=password]')).toBeNull();
    const expiry = fill();
    fireEvent.click(screen.getByRole('button', { name: 'Propose renewal' }));
    await screen.findByRole('status');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/vault/org-held/renew', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...acting.headers },
      body: JSON.stringify({ orgDid, provider: 'anthropic', expiresAt: new Date(expiry).toISOString() }),
    });
    expect(screen.getByRole('link', { name: 'sign the renewal in your Inbox' }).getAttribute('href')).toBe('/jin');
    expect(screen.getByRole('status').textContent).toContain('not yet applied');
  });
  it.each(['http', 'network'])('contains %s errors and never falls back to load/replace', async failure => {
    const fetch = vi.fn();
    if (failure === 'http') fetch.mockResolvedValue(new Response('private diagnostic', { status: 409 }));
    else fetch.mockRejectedValue(new Error('private diagnostic'));
    vi.stubGlobal('fetch', fetch);
    render(<OrgHeldRenewalForm orgDid={orgDid} provider="anthropic" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Propose renewal' }));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('private diagnostic');
    expect(screen.queryByRole('link', { name: /load|replace/i })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a past expiry without posting', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<OrgHeldRenewalForm orgDid={orgDid} provider="anthropic" />);
    fireEvent.change(screen.getByLabelText('New grant expiry (local time)'), { target: { value: '2000-01-01T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose renewal' }));
    await screen.findByRole('alert');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('prevents duplicate submissions while a proposal is pending', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    render(<OrgHeldRenewalForm orgDid={orgDid} provider="anthropic" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Propose renewal' }));
    expect(screen.getByRole('button', { name: 'Proposing…' }).hasAttribute('disabled')).toBe(true);
    finish(Response.json({ status: 'pending' }));
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('renders only allowlisted renewal metadata and handles incomplete detail', () => {
    render(<VaultRenewalApproval detail={{ orgDid, provider: 'anthropic', wrappedKey: 'must-not-render', expiresAt: 123 }} />);
    expect(document.body.textContent).toContain(orgDid);
    expect(document.body.textContent).not.toContain('must-not-render');
    expect(document.body.textContent).not.toContain('123');
    cleanup();
    render(<VaultRenewalApproval detail={null} />);
    expect(screen.getByText(/No reveal/)).toBeDefined();
  });
  it('binds the page to the card-selected org/provider and disables missing targets', async () => {
    render(await Page({ searchParams: Promise.resolve({ orgDid, provider: 'anthropic' }) }));
    expect(screen.getByText(`Owning organization: ${orgDid}`)).toBeDefined();
    cleanup();
    render(await Page({ searchParams: Promise.resolve({}) }));
    fill();
    expect(screen.getByRole('button', { name: 'Propose renewal' }).hasAttribute('disabled')).toBe(true);
  });
});
